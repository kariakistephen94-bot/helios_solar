"""Conversational website booking with a separate signed customer confirmation."""
import base64
import hashlib
import hmac
import json
import time
from datetime import datetime,timedelta,timezone
from uuid import uuid4
from zoneinfo import ZoneInfo
from fastapi import HTTPException,Request
from pydantic import BaseModel,Field,ConfigDict,field_validator
from .calendar import central_time
from .db import StoreError

class Proposal(BaseModel):
    model_config=ConfigDict(extra='forbid')
    start_local:str=Field(max_length=16)
    name:str=Field(min_length=1,max_length=100)
    email:str=Field(max_length=180,pattern=r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
    notes:str=Field(default='',max_length=2000)
    @field_validator('name','email')
    @classmethod
    def trim(cls,v):
        if not v.strip():raise ValueError('Required')
        return v.strip()

class ConfirmBooking(BaseModel):
    model_config=ConfigDict(extra='forbid')
    token:str=Field(min_length=10,max_length=7000)
    consent:bool

TOOLS=[
 {'type':'function','name':'check_consultation_availability','description':'Check one exact 30-minute consultation slot in Central time. Does not reserve or book it. Clarify ambiguous dates and times first.',
  'strict':True,'parameters':{'type':'object','properties':{'start_local':{'type':'string','description':'Exact date and time in America/Chicago as YYYY-MM-DDTHH:MM. Slots start at :00 or :30.'}},'required':['start_local'],'additionalProperties':False}},
 {'type':'function','name':'prepare_consultation','description':'Prepare an appointment review card after the visitor has provided their own name, email and exact desired time. Checks availability but never books. Customer must click Confirm booking on the review card.',
  'strict':True,'parameters':{'type':'object','properties':{
   'start_local':{'type':'string','description':'Exact agreed Central-time datetime, YYYY-MM-DDTHH:MM.'},
   'name':{'type':'string','description':'Visitor name explicitly supplied in this conversation. Never infer or invent.'},
   'email':{'type':'string','description':'Visitor email explicitly supplied in this conversation. Never invent.'},
   'notes':{'type':'string','description':'Brief factual summary of solar or battery needs. Empty if not provided.'}},
   'required':['start_local','name','email','notes'],'additionalProperties':False}},
]

def slot(value):
    start=central_time(value)
    local=start.astimezone(ZoneInfo('America/Chicago'))
    now=datetime.now(timezone.utc)
    if not now+timedelta(minutes=15)<start<=now+timedelta(days=90):
        raise HTTPException(422,'Choose a consultation at least 15 minutes ahead and within the next 90 days.')
    if local.weekday()>4 or local.hour<9 or local.hour>16 or (local.hour==16 and local.minute>30) or local.minute not in (0,30):
        raise HTTPException(422,'Choose a 30-minute slot Monday to Friday, between 9 am and 5 pm Central, starting on the hour or half hour.')
    return start

def display(start):
    return start.astimezone(ZoneInfo('America/Chicago')).strftime('%A, %B %-d, %Y at %-I:%M %p')+' Central'

def register_booking(app,cfg,store):
    secret=cfg.ip_hash_salt.encode()
    async def action(name,payload):
        try:result=await store.rpc('helios_website_booking',{'p_action':name,'p_payload':payload})
        except StoreError:
            raise HTTPException(503,'Online booking is temporarily unavailable. Please use the consultation request form.') from None
        if result.get('error'):
            messages={'slot_conflict':'That time is no longer available. Please choose another slot.',
                      'invalid_time':'That time cannot be booked. Choose a future weekday slot between 9 am and 5 pm Central.',
                      'booking_limit':'The booking limit has been reached. Please contact the team.',
                      'invalid_request':'This booking request could not be verified.'}
            raise HTTPException(409,messages.get(result['error'],'Unable to book that appointment.'))
        return result

    def client_hash(request):
        ip=request.client.host if request.client else 'unknown'
        return hmac.new(secret,ip.encode(),hashlib.sha256).hexdigest()

    def sign(payload):
        raw=base64.urlsafe_b64encode(json.dumps(payload,separators=(',',':')).encode()).decode().rstrip('=')
        signature=hmac.new(secret,raw.encode(),hashlib.sha256).hexdigest()
        return raw+'.'+signature

    def verify(token,request):
        try:
            raw,signature=token.rsplit('.',1)
            expected=hmac.new(secret,raw.encode(),hashlib.sha256).hexdigest()
            if not hmac.compare_digest(signature,expected):raise ValueError()
            payload=json.loads(base64.urlsafe_b64decode(raw+'='*(-len(raw)%4)))
            if payload['client_hash']!=client_hash(request):raise ValueError()
            if payload['expires_at']<time.time():
                raise HTTPException(409,'This booking review expired. If you already tried confirming it, check with the team before making another booking.')
            return payload
        except (ValueError,KeyError,TypeError):
            raise HTTPException(400,'The booking request could not be verified.') from None

    async def tool(name,arguments,request):
        if len(secret)<32:
            raise HTTPException(503,'Online booking is not configured yet. Please use the consultation form.')
        try:
            data=json.loads(arguments)
            if name=='check_consultation_availability':
                if set(data)!={'start_local'}:raise ValueError()
                start=slot(data['start_local'])
                await action('availability',{'starts_at':start.isoformat()})
                return {'reply':display(start)+' is available for a 30-minute consultation. Would you like to book that time?'}
            if name!='prepare_consultation':raise ValueError()
            proposal=Proposal.model_validate(data)
            # Details must appear in customer messages, not just AI-authored history.
            customer_text='\n'.join(m.content for m in request.state.chat_messages if m.role=='user').casefold()
            if proposal.email.casefold() not in customer_text or proposal.name.casefold() not in customer_text:
                return {'reply':'What name and email should I use for your consultation?'}
            start=slot(proposal.start_local)
            await action('availability',{'starts_at':start.isoformat()})
            payload={'request_id':str(uuid4()),'starts_at':start.isoformat(),'name':proposal.name,
                     'email':proposal.email.lower(),'notes':proposal.notes,'client_hash':client_hash(request),'expires_at':int(time.time())+900}
            return {'reply':'Please review the details below and confirm when you’re ready. The appointment is not booked yet.',
                    'booking':{'token':sign(payload),'name':proposal.name,'email':proposal.email.lower(),
                               'starts_at':start.isoformat(),'ends_at':(start+timedelta(minutes=30)).isoformat(),
                               'display_time':display(start),'duration_minutes':30}}
        except HTTPException as error:
            return {'reply':error.detail}
        except (ValueError,TypeError,KeyError):
            return {'reply':'I need a valid name, email, and exact consultation time before preparing your booking.'}

    @app.post('/v1/chat/booking/confirm')
    async def confirm(body:ConfirmBooking,request:Request):
        if request.headers.get('origin') not in cfg.cors_origins:raise HTTPException(403,'Origin denied')
        if len(secret)<32:raise HTTPException(503,'Online booking is not configured.')
        if body.consent is not True:raise HTTPException(422,'Please confirm that we may save these details for your appointment.')
        payload=verify(body.token,request)
        result=await action('confirm',payload)
        event=result['event']
        if event['status']!='scheduled':
            raise HTTPException(409,'This appointment is no longer scheduled. Please contact the team before booking again.')
        start=datetime.fromisoformat(event['starts_at'].replace('Z','+00:00'))
        return {'reply':'Your 30-minute consultation is booked for '+display(start)+'.',
                'appointment':{'id':event['id'],'display_time':display(start),'starts_at':event['starts_at'],'ends_at':event['ends_at'],'status':event['status']}}

    return tool
