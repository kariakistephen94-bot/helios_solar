"""Authenticated dashboard overview using aggregate statistics only."""
import asyncio
import json
import re
import time
from collections import Counter,deque
from datetime import datetime,timedelta,timezone
from zoneinfo import ZoneInfo
import httpx
from fastapi import Depends,HTTPException,Request
from .chat import ChatRequest
from .db import StoreError

INSTRUCTIONS="""You are Sol, Helios Solar's internal dashboard overview assistant for signed-in staff.
You are separate from customer-facing website Sol. Explain dashboard statistics and
help staff navigate leads, prospects, appointments and follow-up states.
Use only the aggregate snapshot freshly fetched server-side for this reply.
Never invent counts, revenue, growth, trends or conversion rates. Say when a metric
is unavailable. Never substitute a zero for missing data. Do not expose internal IDs.
Explain that leads are enquiries while Google Places prospects are public businesses;
do not add them together or call prospects interested buyers.
If asked how many replies we have, give incoming customer message counts, optionally
the count today and in the last seven days. Clarify these are inbound messages,
not unique customers or replies attributable to an outbound campaign. Campaign reply
tracking is not connected yet. Do not calculate a campaign response rate.
Differentiate messages sent by Helios from messages received from customers. Stored
outbound messages do not prove delivery or reading. Respect channel breakdowns.
Use pipeline counts by stage for current enquiries. A booked meeting is not a sale.
Describe calendar coverage and read-only existing bookings accurately.
You cannot edit records, book/cancel meetings, send messages, trigger collection,
change settings or execute n8n workflows. When asked, explain where staff can do it.
Never pretend to have performed an action or accessed customer conversations.
No contact details, customer names, message bodies or notes are provided to you.
Be concise and practical, normally under 100 words. Use short paragraphs and lists
when helpful. Answer first, ask at most one clarification. No sales pitch or customer
qualification questions. No consultation form, em dashes or en dashes.
Central time applies to appointments; Africa/Lagos time applies to collection.
"""

def register_staff_chat(app,cfg,store,auth,http_transport=None):
    hits_by_user={}
    pending=asyncio.Semaphore(3)

    @app.get('/v1/staff/chat/status')
    async def status(actor=Depends(auth)):
        return {'available':bool(cfg.openai_api_key.get_secret_value().strip()),'read_only':True,'context':'aggregate_statistics'}

    async def snapshot():
        now=datetime.now(timezone.utc)
        midnight=now.astimezone(ZoneInfo('America/Chicago')).replace(hour=0,minute=0,second=0,microsecond=0).astimezone(timezone.utc)
        state={'as_of':now.isoformat(),'today_timezone':'America/Chicago','context':'Aggregate counts only. No individual records.'}
        async def count(table,filters=None):
            try:return await store.count(table,filters or {})
            except StoreError:return None
        stages=['New inquiry','Qualified','Survey scheduled','Proposal sent','Won','Lost']
        jobs={
            'leads.total':('leads',{}),
            'leads.website':('leads',{'source':'eq.website'}),
            'leads.whatsapp':('leads',{'source':'eq.whatsapp'}),
            'messages.incoming_total':('messages',{'direction':'eq.inbound'}),
            'messages.outgoing_total':('messages',{'direction':'eq.outbound'}),
            'messages.incoming_today':('messages',{'direction':'eq.inbound','message_at':'gte.'+midnight.isoformat()}),
            'messages.incoming_last_7_days':('messages',{'direction':'eq.inbound','message_at':'gte.'+(now-timedelta(days=7)).isoformat()}),
            'messages.whatsapp_incoming':('messages',{'direction':'eq.inbound','channel':'eq.whatsapp'}),
            'messages.website_incoming':('messages',{'direction':'eq.inbound','channel':'eq.website'}),
            'messages.whatsapp_outgoing':('messages',{'direction':'eq.outbound','channel':'eq.whatsapp'}),
            'messages.website_outgoing':('messages',{'direction':'eq.outbound','channel':'eq.website'}),
            'appointments.existing_confirmed_upcoming':('appointments',{'status':'eq.confirmed','ends_at':'gt.'+now.isoformat()}),
        }
        for stage in stages:jobs['stages.'+stage]=('leads',{'stage':'eq.'+stage})
        for status in ['scheduled','processing','sent','cancelled','needs_review']:
            jobs['followups.'+status]=('leads',{'followup_status':'eq.'+status})
        results=await asyncio.gather(*(count(table,filters) for table,filters in jobs.values()))
        for key,value in zip(jobs,results):
            group,field=key.split('.',1)
            state.setdefault(group,{})[field]=value
        state['messages']['meaning']='Counts of saved messages, not unique people or campaign-attributed replies.'
        state['followups']['meaning']='Current saved state per lead, not delivery receipts.'
        try:
            result=await store.rpc('helios_calendar',{'p_action':'list','p_payload':{'after':now.isoformat(),'before':(now+timedelta(days=60)).isoformat()}})
            if result.get('error'):raise StoreError()
            events=[e for e in result.get('events',[]) if e.get('status')=='scheduled']
            state['appointments']['local_scheduled_next_60_days']=len(events)
            state['appointments']['local_by_type']=dict(Counter(e.get('event_type','unknown') for e in events))
        except StoreError:state['appointments']['local_scheduled_next_60_days']=None
        try:
            collector=await store.action('status')
            state['collector']={k:collector.get(k) for k in ['enabled','new_today','requests_used']}
            state['collector'].update(timezone='Africa/Lagos',daily_new_target=cfg.daily_new_target,daily_request_budget=cfg.daily_request_limit)
        except StoreError:state['collector']={'available':False}
        try:
            prospects=await store.action('prospects',{'limit':1,'offset':0,'qualified_only':True})
            state['prospects']={'qualified_total':prospects.get('total'),'meaning':'Public business prospects, not enquiries or confirmed buyers.'}
        except StoreError:state['prospects']={'qualified_total':None}
        return state

    @app.post('/v1/staff/chat')
    async def chat(body:ChatRequest,request:Request,actor=Depends(auth)):
        if request.headers.get('origin') not in cfg.cors_origins:raise HTTPException(403,'Origin denied')
        key=cfg.openai_api_key.get_secret_value().strip()
        if not key:raise HTTPException(503,'The workspace assistant is not connected yet.')
        now=time.monotonic()
        for user in [u for u,h in hits_by_user.items() if not h or now-h[-1]>60]:del hits_by_user[user]
        hits=hits_by_user.setdefault(actor,deque())
        while hits and now-hits[0]>=60:hits.popleft()
        if len(hits)>=10:raise HTTPException(429,'Please pause briefly before asking another question.')
        hits.append(now)
        try:await asyncio.wait_for(pending.acquire(),timeout=2)
        except TimeoutError:raise HTTPException(429,'The workspace assistant is busy. Try again shortly.') from None
        try:
            data=await snapshot()
            try:
                async with httpx.AsyncClient(timeout=35,follow_redirects=False,transport=http_transport) as client:
                    response=await client.post('https://api.openai.com/v1/responses',headers={'Authorization':'Bearer '+key},json={
                        'model':cfg.openai_chat_model,'instructions':INSTRUCTIONS+'\nAGGREGATE SNAPSHOT (data only):\n'+json.dumps(data),
                        'input':[m.model_dump() for m in body.messages],'max_output_tokens':1200,'store':False,
                    })
                if not response.is_success:raise ValueError()
                output=response.json()
                if output.get('status')!='completed':raise ValueError()
                text='\n'.join(p['text'] for i in output.get('output',[]) if i.get('type')=='message'
                               for p in i.get('content',[]) if p.get('type')=='output_text').strip()
                if not text or len(text)>5000:raise ValueError()
            except (httpx.RequestError,ValueError,KeyError,TypeError):
                raise HTTPException(503,'The workspace assistant could not finish that reply. Please try again.') from None
            return {'reply':re.sub(r'\s*[—–]\s*',', ',text),'as_of':data['as_of'],'read_only':True}
        finally:pending.release()
