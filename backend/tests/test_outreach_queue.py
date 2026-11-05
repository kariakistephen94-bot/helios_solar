import json
import httpx
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app

ID='22222222-2222-4222-8222-222222222222'
AUTH={'Authorization':'Bearer staff-token'}

def test_queue_requires_staff_and_uses_stored_prospect():
    calls=[]
    def handler(request):
        if request.url.path=='/auth/v1/user':return httpx.Response(200,json={'id':'11111111-1111-4111-8111-111111111111'})
        if request.url.path=='/rest/v1/staff_members':return httpx.Response(200,json=[{'user_id':'staff'}])
        assert request.url.path=='/rest/v1/rpc/helios_outreach'
        body=json.loads(request.content);calls.append(body)
        if body['p_action']=='prospect':
            return httpx.Response(200,json={'prospect':{'id':ID,'name':'Sunrise Hotel Limited','phone':'+2348000000000','version':2}})
        return httpx.Response(200,json={'job':body['p_payload'],'already_exists':False})
    cfg=Settings(_env_file=None,supabase_url='https://test.supabase.co',supabase_anon_key='anon',supabase_secret_key='sb_secret_test')
    with TestClient(create_app(cfg,httpx.MockTransport(handler))) as c:
        body={'request_id':ID,'prospect_id':ID}
        assert c.post('/v1/outreach/jobs',json=body).status_code in (401,403)
        assert not calls
        assert c.post('/v1/outreach/jobs',headers=AUTH,json={**body,'message_text':'Injected'}).status_code==422
        result=c.post('/v1/outreach/jobs',headers=AUTH,json=body)
        assert result.status_code==200
        job=result.json()['job']
        assert job['business_name']=='Sunrise Hotel'
        assert job['prospect_version']==2
        assert 'at Sunrise Hotel?' in job['message_text']
        assert [b['p_action'] for b in calls]==['prospect','create']
