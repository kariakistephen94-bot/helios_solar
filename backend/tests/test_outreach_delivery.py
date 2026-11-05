import json
import httpx
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app

def test_live_test_claim_is_separate_from_rehearsal_and_requires_auth():
    calls=[]
    def handler(request):
        assert request.url.path=='/rest/v1/rpc/helios_gateway_test_delivery'
        calls.append(json.loads(request.content))
        return httpx.Response(200,json={'can_send':False,'status':'needs_recent_inbound'})
    cfg=Settings(_env_file=None,supabase_url='https://test.supabase.co',supabase_anon_key='anon',supabase_secret_key='sb_secret_test',n8n_outreach_webhook_secret='private-integration-key',gateway_test_delivery_enabled=True)
    with TestClient(create_app(cfg,httpx.MockTransport(handler))) as c:
        path='/v1/integrations/n8n/outreach/22222222-2222-4222-8222-222222222222/test-claim'
        body={'execution_id':'123','dry_run':False}
        assert c.post(path,json=body).status_code==401
        assert not calls
        r=c.post(path,headers={'X-Helios-Key':'private-integration-key'},json=body)
        assert r.status_code==200 and r.json()['can_send'] is False
        assert calls[0]['p_action']=='claim'
        assert 'recipient' not in calls[0]['p_payload']

