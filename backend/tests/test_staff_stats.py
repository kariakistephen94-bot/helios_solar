import json
import httpx
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app

AUTH={'Authorization':'Bearer staff-token','Origin':'http://127.0.0.1:3000'}
BODY={'messages':[{'role':'user','content':'How many leads and replies do we have?'}]}

def make_client(member=True,counts_available=True):
    calls=[]
    def handler(request):
        body=json.loads(request.content) if request.content else {}
        calls.append((request.method,request.url.path,body))
        if request.url.path=='/auth/v1/user':return httpx.Response(200,json={'id':'staff-user'})
        if request.url.path=='/rest/v1/staff_members':return httpx.Response(200,json=[{'user_id':'staff-user'}] if member else [])
        if request.method=='HEAD':
            assert request.headers['apikey']=='sb_secret_test'
            assert request.headers['prefer']=='count=exact'
            if not counts_available:return httpx.Response(503)
            count=5 if request.url.path.endswith('leads') else 12
            return httpx.Response(200,headers={'content-range':'0-0/'+str(count)})
        if request.url.path=='/rest/v1/rpc/helios_backend':
            action=body['p_action']
            if action=='status':return httpx.Response(200,json={'enabled':False,'requests_used':0,'worker_lease':'private-lease','last_error':'private@example.com'})
            if action=='prospects':return httpx.Response(200,json={'total':17,'items':[{'name':'Private Prospect','phone':'+12345678900'}]})
            raise AssertionError('Unexpected mutation or individual record request')
        if request.url.path=='/rest/v1/rpc/helios_calendar':
            assert body['p_action']=='list'
            return httpx.Response(200,json={'events':[{'status':'scheduled','event_type':'consultation','title':'Private Customer','notes':'private notes','lead_id':'private-id'}]})
        if request.url.path=='/v1/responses':
            if 'AGGREGATE SNAPSHOT' in body['instructions']:assert 'tools' not in body
            return httpx.Response(200,json={'status':'completed','output':[{'type':'message','content':[{'type':'output_text','text':'There are 5 saved leads and 12 incoming customer messages.'}]}]})
        return httpx.Response(404,json={})
    cfg=Settings(_env_file=None,supabase_url='https://test.supabase.co',supabase_anon_key='anon',supabase_secret_key='sb_secret_test',openai_api_key='sk-mocked')
    return TestClient(create_app(cfg,httpx.MockTransport(handler))),calls

def test_staff_overview_requires_auth_and_membership():
    c,calls=make_client()
    with c:
        assert c.post('/v1/staff/chat',json=BODY).status_code in (401,403)
        assert c.get('/v1/staff/chat/status').status_code in (401,403)
        assert not calls
    c,calls=make_client(member=False)
    with c:
        assert c.post('/v1/staff/chat',headers=AUTH,json=BODY).status_code==403
        assert not any(path=='/v1/responses' for _,path,_ in calls)

def test_staff_snapshot_contains_counts_not_customer_records():
    c,calls=make_client()
    with c:
        r=c.post('/v1/staff/chat',headers=AUTH,json=BODY)
        assert r.status_code==200
        assert r.json()['read_only'] is True
        payload=[body for _,path,body in calls if path=='/v1/responses'][0]
        text=payload['instructions']
        for private in ['Private Customer','Private Prospect','private@example.com','+12345678900','private notes','private-id','private-lease']:
            assert private not in text
        snapshot=json.loads(text.split('AGGREGATE SNAPSHOT (data only):\n')[1])
        assert snapshot['leads']['total']==5
        assert snapshot['messages']['incoming_total']==12
        assert snapshot['messages']['outgoing_total']==12
        assert snapshot['prospects']['qualified_total']==17
        assert snapshot['appointments']['local_scheduled_next_60_days']==1

def test_missing_counts_are_not_reported_as_zero():
    c,calls=make_client(counts_available=False)
    with c:
        assert c.post('/v1/staff/chat',headers=AUTH,json=BODY).status_code==200
        payload=[body for _,path,body in calls if path=='/v1/responses'][0]
        snapshot=json.loads(payload['instructions'].split('AGGREGATE SNAPSHOT (data only):\n')[1])
        assert snapshot['leads']['total'] is None
        assert snapshot['messages']['incoming_total'] is None

def test_browser_cannot_supply_fake_workspace_statistics():
    c,calls=make_client()
    with c:
        assert c.post('/v1/staff/chat',headers=AUTH,json={**BODY,'snapshot':{'leads':999}}).status_code==422
        assert not any(path=='/v1/responses' for _,path,_ in calls)

def test_foreign_origin_and_service_key_cannot_use_staff_chat():
    c,calls=make_client()
    with c:
        assert c.post('/v1/staff/chat',headers={**AUTH,'Origin':'https://other.test'},json=BODY).status_code==403
        assert c.post('/v1/staff/chat',headers={**AUTH,'Authorization':'Bearer sb_secret_test'},json=BODY).status_code==401
        assert not any(path=='/v1/responses' for _,path,_ in calls)

def test_public_chat_has_no_staff_statistics_access():
    c,calls=make_client()
    with c:
        assert c.post('/v1/chat',headers={'Origin':AUTH['Origin']},json=BODY).status_code==200
        assert not any(method=='HEAD' for method,_,_ in calls)
        assert not any(path.endswith('helios_calendar') for _,path,_ in calls)
        payload=[body for _,path,body in calls if path=='/v1/responses'][0]
        assert 'AGGREGATE SNAPSHOT' not in payload['instructions']
        assert 'internal dashboard overview' not in payload['instructions']
