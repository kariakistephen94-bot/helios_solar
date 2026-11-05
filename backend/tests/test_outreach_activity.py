import json
import httpx
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app

def test_activity_is_staff_only_and_uses_authenticated_actor():
    calls=[]
    def handler(request):
        if request.url.path=='/auth/v1/user':return httpx.Response(200,json={'id':'11111111-1111-4111-8111-111111111111'})
        if request.url.path=='/rest/v1/staff_members':return httpx.Response(200,json=[{'user_id':'member'}])
        assert request.url.path=='/rest/v1/rpc/helios_outreach_activity'
        body=json.loads(request.content);calls.append(body)
        return httpx.Response(200,json={'summary':{'sent':1,'failed':1},'items':[],'total':0})
    cfg=Settings(_env_file=None,supabase_url='https://test.supabase.co',supabase_anon_key='anon',supabase_secret_key='sb_secret_test')
    with TestClient(create_app(cfg,httpx.MockTransport(handler))) as c:
        assert c.get('/v1/outreach/activity').status_code in (401,403)
        assert not calls
        assert c.get('/v1/outreach/activity?status=failed&limit=10&offset=20',headers={'Authorization':'Bearer staff-token'}).status_code==200
        assert calls[0]=={'p_actor':'11111111-1111-4111-8111-111111111111','p_status':'failed','p_limit':10,'p_offset':20}
        assert c.get('/v1/outreach/activity?status=fake',headers={'Authorization':'Bearer staff-token'}).status_code==422
