"""Receive receipt events only. Never creates conversation messages or sends replies."""
from datetime import datetime,timezone,timedelta
import hashlib
import hmac
from typing import Literal
from fastapi import Depends,Header,HTTPException,Request
from pydantic import BaseModel,ConfigDict,Field,ValidationError,field_validator,model_validator

class Receipt(BaseModel):
    model_config=ConfigDict(extra='forbid')
    event_id:str=Field(pattern=r'^gwevt_[a-f0-9]{32}$')
    event:Literal['message_status']
    provider:Literal['linked_gateway']
    message_id:str=Field(pattern=r'^[A-Za-z0-9_-]{8,200}$')
    sender:Literal['2348107920394']
    recipient:str=Field(pattern=r'^[1-9][0-9]{6,14}$')
    status:Literal['sent','delivered','read','failed']
    occurred_at:datetime
    timestamp_source:Literal['provider','observed']

    @field_validator('occurred_at')
    @classmethod
    def timestamp(cls,value):
        if value.tzinfo is None or value.utcoffset() is None:raise ValueError('Timezone required')
        value=value.astimezone(timezone.utc)
        if value<datetime(2015,1,1,tzinfo=timezone.utc) or value>datetime.now(timezone.utc)+timedelta(minutes=5):
            raise ValueError('Timestamp out of range')
        return value

    @model_validator(mode='after')
    def identity(self):
        expected='gwevt_'+hashlib.sha256(f'{self.sender}:{self.message_id}:{self.status}'.encode()).hexdigest()[:32]
        if not hmac.compare_digest(self.event_id,expected):raise ValueError('Event ID mismatch')
        return self

def register_gateway_receipts(app,cfg,store):
    async def authenticate(x_helios_gateway_key:str|None=Header(default=None)):
        expected=cfg.gateway_status_webhook_secret.get_secret_value()
        if not expected:raise HTTPException(503,'Gateway status receiver is not configured')
        if not x_helios_gateway_key or not hmac.compare_digest(expected.encode(),x_helios_gateway_key.encode()):
            raise HTTPException(401,'Invalid gateway status credential')

    @app.post('/v1/integrations/gateway/message-status',dependencies=[Depends(authenticate)])
    async def receive(request:Request,x_helios_event_id:str|None=Header(default=None)):
        raw=bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw)>8192:raise HTTPException(413,'Status event too large')
        try:body=Receipt.model_validate_json(bytes(raw))
        except (ValidationError,ValueError):raise HTTPException(422,'Invalid gateway status event') from None
        if x_helios_event_id is not None and x_helios_event_id!=body.event_id:
            raise HTTPException(422,'Event header mismatch')
        result=await store.rpc('helios_gateway_receipt',{'p_event':body.model_dump(mode='json')})
        if result.get('error'):raise HTTPException(422,'Conflicting or invalid gateway receipt')
        return result
