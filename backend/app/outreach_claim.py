"""Authenticated n8n rehearsal and allowlisted linked-gateway text claims."""
import hmac
from typing import Literal
from uuid import UUID
from fastapi import Depends, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from .db import StoreError

class TestClaim(BaseModel):
    model_config=ConfigDict(extra='forbid')
    execution_id: str=Field(min_length=1,max_length=100,pattern=r'^\S+$')
    dry_run: bool

class DeliveryResult(BaseModel):
    model_config=ConfigDict(extra='forbid')
    claim_id: UUID
    execution_id: str=Field(min_length=1,max_length=100,pattern=r'^\S+$')
    outcome: Literal['accepted','failed','unknown']
    message_id: str | None=Field(default=None,max_length=1000)

def register_outreach_claim(app,cfg,store):
    async def authenticate(x_helios_key: str | None=Header(default=None)):
        expected=cfg.n8n_outreach_webhook_secret.get_secret_value()
        if not expected:
            raise HTTPException(503,'Configure the n8n webhook secret on the backend')
        if not x_helios_key or not hmac.compare_digest(x_helios_key.encode(),expected.encode()):
            raise HTTPException(401,'Invalid integration credential')

    @app.post('/v1/integrations/n8n/outreach/{job_id}/test-claim',dependencies=[Depends(authenticate)])
    async def claim(job_id: UUID,body: TestClaim):
        if not body.dry_run:
            # Jobs sent by the paced dispatcher use the live claim; undispatched jobs keep the test path.
            if cfg.outreach_dispatch_enabled:
                try:
                    live=await store.rpc('helios_outreach_live_claim',{'p_payload':{'job_id':str(job_id),'execution_id':body.execution_id}})
                except StoreError:
                    # Upgrade not applied yet: fall back to the allowlisted test claim, which stays restricted.
                    live={'status':'use_test_path'}
                if live.get('status')!='use_test_path':
                    return live
            if not cfg.gateway_test_delivery_enabled:
                return {'success':False,'can_send':False,'status':'test_delivery_disabled'}
            return await store.rpc('helios_gateway_test_delivery',{
                'p_action':'claim','p_payload':{'job_id':str(job_id),'execution_id':body.execution_id},
            })
        return await store.rpc('helios_outreach_test_claim',{
            'p_job_id':str(job_id),'p_execution_id':body.execution_id,
        })

    @app.post('/v1/integrations/n8n/outreach/test-result',dependencies=[Depends(authenticate)])
    async def result(body: DeliveryResult):
        return await store.rpc('helios_gateway_test_delivery',{
            'p_action':'result','p_payload':body.model_dump(mode='json'),
        })
