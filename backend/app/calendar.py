"""Staff-only local calendar and read-only visibility of existing appointments."""
from datetime import datetime,timedelta,timezone
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo
from fastapi import Depends,HTTPException,Query
from pydantic import BaseModel,Field,ConfigDict,field_validator
from .db import StoreError

class EventInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    id: UUID
    title: str=Field(min_length=1,max_length=160)
    event_type: Literal['consultation','site_visit','installation','follow_up']
    lead_id: UUID|None=None
    start_local: str=Field(max_length=16)
    end_local: str=Field(max_length=16)
    notes: str=Field(default='',max_length=3000)
    status: Literal['scheduled','completed']='scheduled'
    version: int=Field(default=1,ge=1)
    @field_validator('title')
    @classmethod
    def title_not_blank(cls,value):
        if not value.strip(): raise ValueError('Title is required')
        return value.strip()

class CancelInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    version:int=Field(ge=1)

def central_time(value):
    try:
        local=datetime.strptime(value,'%Y-%m-%dT%H:%M')
    except ValueError:
        raise HTTPException(422,'Use a valid local date and time.') from None
    zone=ZoneInfo('America/Chicago')
    aware=local.replace(tzinfo=zone)
    if aware.astimezone(timezone.utc).astimezone(zone).replace(tzinfo=None)!=local:
        raise HTTPException(422,'That time does not exist due to daylight saving. Choose another time.')
    if aware.utcoffset()!=local.replace(tzinfo=zone,fold=1).utcoffset():
        raise HTTPException(422,'That time is ambiguous due to daylight saving. Choose another time.')
    return aware.astimezone(timezone.utc)

def register_calendar(app,cfg,store,auth):
    async def calendar_action(action,payload):
        try: result=await store.rpc('helios_calendar',{'p_action':action,'p_payload':payload})
        except StoreError:
            raise HTTPException(503,'Calendar storage is unavailable. Apply the dashboard calendar migration if it has not been installed.') from None
        code=result.get('error') if isinstance(result,dict) else None
        if code:
            messages={'slot_conflict':'That time overlaps an existing appointment. Choose another slot.',
                      'version_conflict':'This event changed. Refresh the calendar before editing.',
                      'request_conflict':'This request was already used for another event.',
                      'not_found':'Appointment not found.','invalid_time':'End time must follow start time, within seven days.'}
            raise HTTPException(404 if code=='not_found' else 409,messages.get(code,'The calendar could not save this change.'))
        return result

    @app.get('/v1/calendar')
    async def calendar(after:datetime,before:datetime,actor=Depends(auth)):
        if after.tzinfo is None or before.tzinfo is None or not timedelta(0)<before-after<=timedelta(days=93):
            raise HTTPException(422,'Choose a timezone-aware range of up to 93 days.')
        payload={'after':after.isoformat(),'before':before.isoformat()}
        available=True
        warning=None
        try: local=(await calendar_action('list',payload)).get('events',[])
        except HTTPException as error:
            if error.status_code!=503:raise
            local=[];available=False;warning=error.detail
        rows=await store.request('GET','/rest/v1/appointments',admin=True,params={
            'select':'id,lead_id,starts_at,ends_at,timezone,status,google_event_id,created_at',
            'starts_at':'lt.'+before.isoformat(),'ends_at':'gt.'+after.isoformat(),
            'order':'starts_at.asc','limit':'1001'})
        for row in rows[:1000]:
            local.append({**row,'id':'existing:'+row['id'],'title':'Solar consultation','event_type':'consultation',
                          'status':{'confirmed':'scheduled','pending':'pending','failed':'failed','cancelled':'cancelled'}.get(row['status'],'pending'),
                          'origin':'whatsapp','editable':False,'notes':'Existing appointment. Manage through its original booking workflow.'})
        return {'events':[{**e,'origin':e.get('origin',e.get('source','dashboard')),'editable':e.get('editable',True)} for e in local],
                'writable':available,'warning':warning,'timezone':'America/Chicago','has_more':len(rows)>1000}

    async def save_event(body,actor,action):
        start,end=central_time(body.start_local),central_time(body.end_local)
        if not timedelta(0)<end-start<=timedelta(days=7):
            raise HTTPException(422,'End time must follow start time, within seven days.')
        payload=body.model_dump(mode='json',exclude={'start_local','end_local'})
        payload.update(starts_at=start.isoformat(),ends_at=end.isoformat(),actor=actor)
        return await calendar_action(action,payload)

    @app.post('/v1/calendar',status_code=201)
    async def create_event(body:EventInput,actor=Depends(auth)):
        if body.status!='scheduled':raise HTTPException(422,'New events must be scheduled.')
        return await save_event(body,actor,'create')

    @app.patch('/v1/calendar/{event_id}')
    async def edit_event(event_id:UUID,body:EventInput,actor=Depends(auth)):
        if event_id!=body.id:raise HTTPException(422,'Appointment IDs must match.')
        return await save_event(body,actor,'update')

    @app.post('/v1/calendar/{event_id}/cancel')
    async def cancel_event(event_id:UUID,body:CancelInput,actor=Depends(auth)):
        return await calendar_action('cancel',{'id':str(event_id),'version':body.version,'actor':actor})

    @app.get('/v1/connections')
    async def connections(actor=Depends(auth)):
        try: ready=(await store.action('status')).get('protocol')==2
        except StoreError:ready=False
        return {'backend':True,'supabase':ready,'website_chat_configured':bool(cfg.openai_api_key.get_secret_value()),
                'collector_configured':bool(cfg.google_places_api_key),'timezone':'America/Chicago'}
