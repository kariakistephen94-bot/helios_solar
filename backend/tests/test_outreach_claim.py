import httpx
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app

def test_claim_authentication_and_send_block():
    calls=[]
    def handler(request):
        calls.append(request.url.path)
        assert request.url.path=='/rest/v1/rpc/helios_outreach_test_claim'
        return httpx.Response(200,json={'success':True,'status':'test_claimed','can_send':False,'dry_run':True})
    cfg=Settings(_env_file=None,supabase_url='https://test.supabase.co',supabase_anon_key='anon',supabase_secret_key='sb_secret_test',n8n_outreach_webhook_secret='private-integration-key')
    with TestClient(create_app(cfg,httpx.MockTransport(handler))) as c:
        path='/v1/integrations/n8n/outreach/22222222-2222-4222-8222-222222222222/test-claim'
        body={'execution_id':'123','dry_run':True}
        assert c.post(path,json=body).status_code==401
        assert c.post(path,headers={'X-Helios-Key':'wrong'},json=body).status_code==401
        assert not calls
        headers={'X-Helios-Key':'private-integration-key'}
        assert c.post(path,headers=headers,json={**body,'dry_run':False}).json()['status']=='test_delivery_disabled'
        r=c.post(path,headers=headers,json=body)
        assert r.status_code==200 and r.json()['can_send'] is False
        assert len(calls)==1
