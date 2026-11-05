import asyncio
import httpx
from fastapi.testclient import TestClient
from app.config import Settings
from app.db import Store
from app.main import create_app
from app.outreach_dispatch import dispatch_once, production_url

JOB='22222222-2222-4222-8222-222222222222'

def cfg(**extra):
    return Settings(_env_file=None,supabase_url='https://test.supabase.co',supabase_anon_key='anon',supabase_secret_key='sb_secret_test',
        n8n_outreach_webhook_secret='private-integration-key',
        n8n_outreach_webhook_url='https://n8n.example.com/webhook-test/abc',**extra)

def run(decision,n8n_status=200,n8n_error=False):
    rpc,hooks=[],[]
    def supabase(request):
        import json
        body=json.loads(request.content)
        rpc.append(body['p_action'])
        return httpx.Response(200,json=decision if body['p_action']=='next' else {'released':True})
    def n8n(request):
        hooks.append(request)
        if n8n_error: raise httpx.ConnectError('down')
        return httpx.Response(n8n_status,json={})
    async def go():
        store=Store(cfg(),httpx.MockTransport(supabase))
        async with httpx.AsyncClient(transport=httpx.MockTransport(n8n)) as client:
            out=await dispatch_once(store,cfg(),client)
        await store.close()
        return out
    return asyncio.run(go()),rpc,hooks

def test_production_url_replaces_test_url():
    assert production_url('https://x/webhook-test/abc')=='https://x/webhook/abc'
    assert production_url('https://x/webhook/abc')=='https://x/webhook/abc'

def test_nothing_due_never_calls_n8n():
    for reason in ('disabled','outside_hours','waiting','daily_cap_reached','nothing_queued'):
        out,rpc,hooks=run({'dispatch':False,'reason':reason})
        assert out==reason and not hooks and rpc==['next']

def test_due_job_is_sent_once_to_the_n8n_production_webhook_with_the_shared_secret():
    out,rpc,hooks=run({'dispatch':True,'job_id':JOB,'next_gap_seconds':700})
    assert out=='dispatched' and rpc==['next'] and len(hooks)==1
    request=hooks[0]
    assert str(request.url)=='https://n8n.example.com/webhook/abc'
    assert request.headers['X-Helios-Key']=='private-integration-key'
    import json
    assert json.loads(request.content)=={'event':'outreach_job','job_id':JOB,'dry_run':False,'source':'helios_backend'}

def test_failed_webhook_releases_the_job_so_it_is_retried_later():
    for kwargs in ({'n8n_status':500},{'n8n_error':True}):
        out,rpc,hooks=run({'dispatch':True,'job_id':JOB},**kwargs)
        assert out=='n8n_unreachable' and rpc==['next','release']

def test_live_claim_is_used_only_when_dispatch_is_enabled_and_falls_back_to_test_path():
    calls=[]
    def handler(request):
        if not request.url.path.endswith('helios_outreach_dispatch'):  # background dispatcher polling
            calls.append(request.url.path)
        if request.url.path.endswith('helios_outreach_live_claim'):
            return httpx.Response(200,json={'status':'use_test_path'})
        return httpx.Response(200,json={'success':True,'can_send':True,'status':'reserved'})
    path=f'/v1/integrations/n8n/outreach/{JOB}/test-claim'
    headers={'X-Helios-Key':'private-integration-key'}
    body={'execution_id':'1','dry_run':False}
    with TestClient(create_app(cfg(gateway_test_delivery_enabled=True),httpx.MockTransport(handler))) as c:
        assert c.post(path,headers=headers,json=body).json()['status']=='reserved'
    assert calls==['/rest/v1/rpc/helios_gateway_test_delivery']
    calls.clear()
    with TestClient(create_app(cfg(gateway_test_delivery_enabled=True,outreach_dispatch_enabled=True),httpx.MockTransport(handler))) as c:
        assert c.post(path,headers=headers,json=body).json()['status']=='reserved'
    assert calls[:2]==['/rest/v1/rpc/helios_outreach_live_claim','/rest/v1/rpc/helios_gateway_test_delivery']

def test_live_claim_result_is_returned_without_touching_the_test_path():
    calls=[]
    def handler(request):
        if not request.url.path.endswith('helios_outreach_dispatch'):  # background dispatcher polling
            calls.append(request.url.path)
        return httpx.Response(200,json={'success':True,'can_send':True,'status':'reserved','claim_id':'x','dispatch':False})
    path=f'/v1/integrations/n8n/outreach/{JOB}/test-claim'
    with TestClient(create_app(cfg(outreach_dispatch_enabled=True),httpx.MockTransport(handler))) as c:
        r=c.post(path,headers={'X-Helios-Key':'private-integration-key'},json={'execution_id':'1','dry_run':False})
    assert r.json()['claim_id']=='x' and calls==['/rest/v1/rpc/helios_outreach_live_claim']
