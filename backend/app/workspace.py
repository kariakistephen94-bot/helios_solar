"""Dashboard data gateway. User-scoped Supabase calls retain existing RLS policies."""
import hashlib
from datetime import datetime
from typing import Literal
from urllib.parse import urlparse
from uuid import UUID
import httpx
from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel, Field, ConfigDict, field_validator

class LeadEdit(BaseModel):
    model_config = ConfigDict(extra='forbid')
    stage: Literal['New inquiry','Qualified','Survey scheduled','Proposal sent','Won','Lost']
    value: float | None = Field(default=None,ge=0,le=1000000,allow_inf_nan=False)
    survey_at: datetime | None = None
    notes: str = Field(max_length=4000)
    @field_validator('survey_at')
    @classmethod
    def aware(cls,value):
        if value and value.tzinfo is None: raise ValueError('Timezone required')
        return value

class Inquiry(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1,max_length=100)
    email: str = Field(min_length=3,max_length=180,pattern=r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
    phone: str = Field(min_length=5,max_length=30)
    city: str = Field(min_length=1,max_length=100)
    address: str = Field(min_length=1,max_length=240)
    bill: float = Field(gt=0,le=10000,allow_inf_nan=False)
    interest: Literal['Home solar','Battery storage','Solar + battery']
    notes: str = Field(default='',max_length=2000)
    consent: Literal[True]
    turnstileToken: str = Field(min_length=1,max_length=3000)
    requestId: UUID
    @field_validator('name','city','address')
    @classmethod
    def nonblank(cls,value):
        if not value.strip(): raise ValueError('Must not be blank')
        return value.strip()

def register_workspace(app,cfg,store,auth,http_transport=None):
    @app.get('/v1/workspace')
    async def workspace(request:Request,actor=Depends(auth)):
        return await store.action('workspace')

    @app.get('/v1/leads')
    async def leads(request:Request,limit:int=50,offset:int=0,actor=Depends(auth)):
        if not 1<=limit<=200 or not 0<=offset<=100000: raise HTTPException(422,'Invalid pagination')
        return await store.action('leads',{'limit':limit,'offset':offset})

    @app.get('/v1/leads/{lead_id}/messages')
    async def messages(lead_id:UUID,actor=Depends(auth)):
        rows=await store.request('GET','/rest/v1/messages',admin=True,params={
            'lead_id':'eq.'+str(lead_id),'order':'message_at.desc,id.desc','limit':'100',
            'select':'id,direction,message_text,message_type,message_at,channel'})
        return {'messages':list(reversed(rows))}

    @app.patch('/v1/leads/{lead_id}')
    async def edit(lead_id:UUID,body:LeadEdit,request:Request,actor=Depends(auth)):
        return await store.action('edit_lead',{'id':str(lead_id),**body.model_dump(mode='json'),'actor':actor})

    @app.post('/v1/inquiries',status_code=201)
    async def inquiry(body:Inquiry,request:Request):
        origin=request.headers.get('origin','')
        if origin not in cfg.cors_origins: raise HTTPException(403,'Origin denied')
        if not cfg.turnstile_secret_key or len(cfg.ip_hash_salt)<32:
            raise HTTPException(503,'Enquiry verification is not configured')
        try:
            async with httpx.AsyncClient(timeout=10,follow_redirects=False,transport=http_transport) as client:
                verify=await client.post('https://challenges.cloudflare.com/turnstile/v0/siteverify',json={'secret':cfg.turnstile_secret_key,'response':body.turnstileToken,'idempotency_key':str(body.requestId)})
                verdict=verify.json()
            if not verify.is_success or not verdict.get('success') or verdict.get('hostname')!=urlparse(origin).hostname:
                raise HTTPException(403,'Verification failed')
        except (httpx.RequestError,ValueError): raise HTTPException(503,'Verification service unavailable') from None
        # Only trust forwarded client addresses when Uvicorn's proxy allowlist is configured.
        ip=request.client.host if request.client else 'unknown'
        bucket=hashlib.sha256((cfg.ip_hash_salt+ip).encode()).hexdigest()
        payload=body.model_dump(mode='json',exclude={'turnstileToken','requestId'})
        await store.action('inquiry',{'request_id':str(body.requestId),'ip_hash':bucket,'lead':payload})
        return {'received':True}
