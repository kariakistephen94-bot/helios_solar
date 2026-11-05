"""Paced dispatch of queued outreach jobs to the n8n outreach workflow.

One job at a time, separated by a random gap, inside Lagos business hours and under a daily cap.
The database decides what is due; this module only delivers the job reference to n8n.
"""
import asyncio
import logging
import httpx
from fastapi import Depends, HTTPException
from pydantic import BaseModel, ConfigDict

log=logging.getLogger('helios.dispatch')
POLL_SECONDS=30

class Configure(BaseModel):
    model_config=ConfigDict(extra='forbid')
    enabled: bool | None=None
    live_recipients: bool | None=None

def production_url(url:str)->str:
    """n8n test URLs only work while the editor is listening; scheduled dispatch needs the production URL."""
    return url.replace('/webhook-test/','/webhook/',1)

async def dispatch_once(store,cfg,client)->str:
    result=await store.rpc('helios_outreach_dispatch',{'p_action':'next','p_payload':{}})
    if not result.get('dispatch'):
        return str(result.get('reason') or result.get('error') or 'idle')
    job_id=result['job_id']
    url=production_url(cfg.n8n_outreach_webhook_url)
    secret=cfg.n8n_outreach_webhook_secret.get_secret_value()
    accepted=False
    if url and secret:
        try:
            response=await client.post(url,headers={'X-Helios-Key':secret},
                json={'event':'outreach_job','job_id':job_id,'dry_run':False,'source':'helios_backend'})
            accepted=response.is_success
        except httpx.RequestError:
            accepted=False
    if not accepted:
        # Safe to release: the claim is idempotent per recipient, so a retry cannot double-send.
        await store.rpc('helios_outreach_dispatch',{'p_action':'release','p_payload':{'job_id':job_id}})
        log.warning('dispatch_rejected job=%s',job_id)
        return 'n8n_unreachable'
    log.info('dispatched job=%s',job_id)
    return 'dispatched'

async def run_dispatcher(store,cfg,transport=None):
    async with httpx.AsyncClient(timeout=15,transport=transport,follow_redirects=False) as client:
        while True:
            try:
                await dispatch_once(store,cfg,client)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.warning('dispatch_tick_unavailable')
            await asyncio.sleep(POLL_SECONDS)

def register_dispatch(app,store,auth):
    async def call(action,payload):
        result=await store.rpc('helios_outreach_dispatch',{'p_action':action,'p_payload':payload})
        if result.get('error'):
            raise HTTPException(403 if result['error']=='staff_required' else 400,'Unable to read outreach pacing')
        return result

    @app.get('/v1/outreach/dispatch')
    async def status(actor=Depends(auth)):
        return await call('status',{'actor':actor})

    @app.patch('/v1/outreach/dispatch')
    async def configure(body:Configure,actor=Depends(auth)):
        return await call('configure',{'actor':actor,**body.model_dump(exclude_none=True)})
