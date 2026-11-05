import asyncio
from contextlib import suppress
from contextlib import asynccontextmanager
from typing import Literal
from uuid import UUID
from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field, ConfigDict
from .config import settings
from .db import Store, StoreError
from .territory import DISTRICTS

STAGES=Literal['New prospect','Qualified','Survey scheduled','Proposal sent','Won','Lost']
class Edit(BaseModel):
    model_config=ConfigDict(extra='forbid')
    stage: STAGES
    notes: str=Field(default='',max_length=4000)
    version: int=Field(ge=1)
class Toggle(BaseModel):
    model_config=ConfigDict(extra='forbid')
    enabled: bool
security=HTTPBearer()

def create_app(cfg=None,http_transport=None):
    cfg=cfg or settings()
    store=Store(cfg,http_transport)
    @asynccontextmanager
    async def lifespan(app):
        from .outreach_automatic import run_automatic_queue
        automatic_task=asyncio.create_task(run_automatic_queue(store)) if cfg.outreach_automatic_enabled else None
        from .outreach_dispatch import run_dispatcher
        dispatch_task=asyncio.create_task(run_dispatcher(store,cfg,http_transport)) if cfg.outreach_dispatch_enabled else None
        try:
            yield
        finally:
            for task in (automatic_task,dispatch_task):
                if task:
                    task.cancel()
                    with suppress(asyncio.CancelledError):
                        await task
            await store.close()
    app=FastAPI(title='Helios API',version='0.2.0',lifespan=lifespan,
                description='Independent dashboard API and Supabase-backed Abuja collector. Staff routes require a user access token.')
    app.state.store=store
    app.add_middleware(CORSMiddleware,allow_origins=cfg.cors_origins,allow_methods=['GET','POST','PATCH'],allow_headers=['Authorization','Content-Type'])
    @app.exception_handler(StoreError)
    async def store_error(request,exc):
        return JSONResponse(status_code=exc.status,content={'detail':exc.code.replace('_',' ')})
    async def auth(credentials:HTTPAuthorizationCredentials=Depends(security)):
        token=credentials.credentials
        # No anon/secret key can authenticate as a staff member.
        if token in (cfg.supabase_anon_key,cfg.supabase_secret_key.get_secret_value()):
            raise HTTPException(401,'A staff user access token is required')
        user=await store.request('GET','/auth/v1/user',token=token)
        if not isinstance(user,dict) or not user.get('id'): raise HTTPException(401,'Invalid user access token')
        membership=await store.request('GET','/rest/v1/staff_members',token=token,params={'user_id':'eq.'+user['id'],'select':'user_id','limit':1})
        if not membership: raise HTTPException(403,'Staff membership required')
        return user['id']
    @app.get('/health/live')
    async def live():return {'status':'ok'}
    @app.get('/health/ready')
    async def ready():
        status=await store.action('status')
        if status.get('protocol')!=2:raise HTTPException(503,'Apply the district rotation migration before enabling collection')
        return {'status':'ready','storage':'supabase'}
    @app.get('/v1/territory')
    async def territory(actor=Depends(auth)):
        return {'name':'Abuja urban pilot','timezone':'Africa/Lagos','country':'NG',
                'bounds':{'south':cfg.south,'north':cfg.north,'west':cfg.west,'east':cfg.east},
                'boundary_type':'individual district pilot windows, not official administrative boundaries','queries':cfg.queries,
                'districts':cfg.districts,'daily_new_target':cfg.daily_new_target,'min_rating':cfg.min_rating,'min_review_count':cfg.min_review_count,
                'public_contact_required':True,'completeness':'Ranked search results; not exhaustive'}
    @app.get('/v1/prospects')
    async def prospects(q:str=Query('',max_length=100),stage:STAGES|None=None,limit:int=Query(50,ge=1,le=200),offset:int=Query(0,ge=0,le=100000),qualified_only:bool=True,actor=Depends(auth)):
        if (await store.action('status')).get('protocol')!=2:raise HTTPException(503,'Apply the district rotation migration')
        return await store.action('prospects',{'q':q,'stage':stage,'limit':limit,'offset':offset,'qualified_only':qualified_only})
    @app.patch('/v1/prospects/{prospect_id}')
    async def edit(prospect_id:UUID,body:Edit,actor=Depends(auth)):
        return await store.action('edit',{'id':str(prospect_id),**body.model_dump(),'actor':actor})
    @app.get('/v1/collector')
    async def collector(actor=Depends(auth)):
        result=await store.action('status')
        if result.get('protocol')!=2:raise HTTPException(503,'Apply the district rotation migration')
        return {**result,'configured':bool(cfg.google_places_api_key),'daily_request_limit':cfg.daily_request_limit,'interval_hours':cfg.scan_interval_hours}
    @app.patch('/v1/collector')
    async def toggle(body:Toggle,actor=Depends(auth)):
        if body.enabled and (await store.action('status')).get('protocol')!=2:raise HTTPException(503,'Apply the district rotation migration')
        if body.enabled and not cfg.google_places_api_key:raise HTTPException(409,'Configure GOOGLE_PLACES_API_KEY on the backend first')
        return await store.action('toggle',{'enabled':body.enabled,'actor':actor})
    @app.post('/v1/scans',status_code=202)
    async def scan(actor=Depends(auth)):
        return await store.action('enqueue',{'actor':actor})
    @app.get('/v1/scans')
    async def scans(limit:int=Query(30,ge=1,le=100),actor=Depends(auth)):
        return await store.action('scans',{'limit':limit})
    from .workspace import register_workspace
    register_workspace(app,cfg,store,auth,http_transport)
    from .chat import register_chat
    register_chat(app,cfg,http_transport,store)
    from .calendar import register_calendar
    register_calendar(app,cfg,store,auth)
    from .staff_chat import register_staff_chat
    register_staff_chat(app,cfg,store,auth,http_transport)
    from .outreach import register_outreach
    register_outreach(app,auth)
    from .outreach_queue import register_outreach_queue
    register_outreach_queue(app,store,auth)
    from .outreach_dispatch import register_dispatch
    register_dispatch(app,store,auth)
    from .outreach_claim import register_outreach_claim
    register_outreach_claim(app,cfg,store)
    from .gateway import register_gateway
    register_gateway(app,cfg,http_transport)
    from .gateway_receipts import register_gateway_receipts
    register_gateway_receipts(app,cfg,store)
    return app
