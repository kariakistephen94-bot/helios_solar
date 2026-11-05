import httpx
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app

def test_gateway_status_requires_integration_auth_and_redacts_identity():
    calls=[]
    def handler(request):
        calls.append(request)
        assert request.url.path=='/status'
        assert request.headers['authorization']=='Bearer private-gateway-key'
        return httpx.Response(200,json={'connected':True,'me':{'id':'private-session-id'},'needsQr':False})
    cfg=Settings(_env_file=None,supabase_url='https://test.supabase.co',supabase_anon_key='anon',supabase_secret_key='sb_secret_test',n8n_outreach_webhook_secret='integration-key',whatsapp_gateway_url='http://127.0.0.1:3001',whatsapp_gateway_api_key='private-gateway-key')
    with TestClient(create_app(cfg,httpx.MockTransport(handler))) as c:
        path='/v1/integrations/n8n/gateway/status'
        assert c.get(path).status_code==401
        assert not calls
        result=c.get(path,headers={'X-Helios-Key':'integration-key'})
        assert result.json()=={'connected':True,'status':'connected','provider':'linked_gateway'}
        assert 'private' not in result.text
        assert len(calls)==1
