import pytest
import httpx
from fastapi.testclient import TestClient
from pydantic import ValidationError
from app.config import Settings
from app.main import create_app
from app.db import Store,StoreError
from app.collector import Places,ProviderError,prepare,eligible
from app.worker import tick
TOKEN='staff-access-token'
ANON='anon-public-test'
SECRET='sb_secret_private-test'

def config(**kwargs):
    return Settings(_env_file=None,**{'supabase_url':'https://test.supabase.co','supabase_anon_key':ANON,'supabase_secret_key':SECRET,**kwargs})

@pytest.fixture
def setup():
    calls=[]
    def handler(request):
        import json
        body=json.loads(request.content) if request.content else {}
        calls.append((request,body))
        if request.url.path=='/auth/v1/user':
            if request.headers.get('authorization')!='Bearer '+TOKEN:return httpx.Response(401,json={})
            assert request.headers['apikey']==ANON
            return httpx.Response(200,json={'id':'test-staff'})
        if request.url.path=='/rest/v1/staff_members':return httpx.Response(200,json=[{'user_id':'test-staff'}])
        if request.url.path in ('/rest/v1/leads','/rest/v1/automation_jobs'):
            assert request.headers['apikey']==ANON and request.headers['authorization']=='Bearer '+TOKEN
            return httpx.Response(200,json=[])
        if request.url.path=='/rest/v1/rpc/helios_backend':
            assert request.headers['apikey']==SECRET and 'authorization' not in request.headers
            action=body['p_action']
            result={'status':{'enabled':False,'requests_used':0,'protocol':2},'prospects':{'items':[],'total':0},'scans':{'items':[]},'claim':None,'workspace':{'leads':[],'jobs':[],'has_more':False},'leads':{'items':[]}}.get(action,{'ok':True})
            return httpx.Response(200,json=result)
        return httpx.Response(404,json={})
    cfg=config()
    app=create_app(cfg,http_transport=httpx.MockTransport(handler))
    with TestClient(app) as client:yield cfg,app,client,calls,{'Authorization':'Bearer '+TOKEN}

def test_key_settings_no_database_url_needed(monkeypatch):
    monkeypatch.setenv('SUPABASE_URL','https://test.supabase.co')
    monkeypatch.setenv('SUPABASE_ANON_KEY',ANON)
    monkeypatch.setenv('SUPABASE_SECRET_KEY',SECRET)
    cfg=Settings(_env_file=None)
    assert cfg.supabase_anon_key==ANON and not hasattr(cfg,'database_url')
    assert SECRET not in repr(cfg)
    monkeypatch.delenv('SUPABASE_ANON_KEY')
    monkeypatch.delenv('SUPABASE_SECRET_KEY')
    monkeypatch.setenv('SUPABASE_PUBLISHABLE_KEY',ANON)
    monkeypatch.setenv('SUPABASE_SERVICE_ROLE_KEY','legacy-service-role-jwt')
    assert Settings(_env_file=None).supabase_anon_key==ANON

def test_missing_keys_fail_closed():
    with pytest.raises(ValidationError):Settings(_env_file=None,supabase_url='https://test.supabase.co')
    with pytest.raises(ValidationError):config(supabase_url='http://example.test')

def test_staff_auth_and_server_only_secret(setup):
    cfg,app,c,calls,h=setup
    assert c.get('/v1/prospects').status_code in (401,403)
    for token in ('wrong',ANON,SECRET):assert c.get('/v1/prospects',headers={'Authorization':'Bearer '+token}).status_code==401
    response=c.get('/v1/prospects',headers=h)
    assert response.json()=={'items':[],'total':0}
    assert SECRET not in response.text
    assert c.get('/health/ready').status_code==200
    assert c.patch('/v1/collector',headers=h,json={'enabled':True}).status_code==409
    assert c.get('/v1/workspace',headers=h).json()=={'leads':[],'jobs':[],'has_more':False}
    assert c.get('/v1/leads?limit=201',headers=h).status_code==422

def test_staff_membership_and_network_errors():
    def nonstaff(r):return httpx.Response(200,json={'id':'user'} if r.url.path=='/auth/v1/user' else [])
    with TestClient(create_app(config(),http_transport=httpx.MockTransport(nonstaff))) as c:
        assert c.get('/v1/prospects',headers={'Authorization':'Bearer '+TOKEN}).status_code==403
    def failure(r):raise httpx.ConnectError('internal sensitive error',request=r)
    with TestClient(create_app(config(),http_transport=httpx.MockTransport(failure))) as c:
        response=c.get('/health/ready')
        assert response.status_code==503 and 'internal sensitive error' not in response.text

async def test_legacy_secret_headers():
    cfg=config();cfg.supabase_secret_key=__import__('pydantic').SecretStr('legacy-service-role-jwt')
    def handler(r):
        assert r.headers['apikey']=='legacy-service-role-jwt'
        assert r.headers['Authorization']=='Bearer legacy-service-role-jwt'
        return httpx.Response(200,json={})
    store=Store(cfg,httpx.MockTransport(handler))
    await store.action('status');await store.close()

def place():
    return {'id':'p1','displayName':{'text':'Example Abuja Business'},'formattedAddress':'10 Pilot Street, Abuja','location':{'latitude':9.07,'longitude':7.45},'addressComponents':[{'shortText':'NG','types':['country']}],'internationalPhoneNumber':'+234 800 000 0000','businessStatus':'OPERATIONAL','rating':4.5,'userRatingCount':15}

def test_territory_and_normalization():
    cfg=config();p=place()
    assert eligible(p,cfg) and len(prepare(p,cfg)['fingerprint'])==64
    p['location']['latitude']=0
    assert prepare(p,cfg) is None
    p=place();del p['internationalPhoneNumber'];assert not eligible(p,cfg)

async def test_google_reserves_budget_before_every_request():
    class Budget:
        used=0
        async def action(self,action,payload):
            assert action=='reserve' and payload['lease']=='fence'
            self.used+=1
            return {'allowed':self.used==1,'retry_after':60}
    def handler(request):
        import json
        body=json.loads(request.content)
        assert body['textQuery']=='businesses in Abuja'
        return httpx.Response(200,json={'places':[place()]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider=Places(config(),Budget(),{'id':'scan','lease':'fence'},client)
        assert (await provider.request(client,{'textQuery':'businesses in Abuja'}))['places']
        with pytest.raises(ProviderError,match='daily_request_budget_exhausted'):await provider.request(client,{})

async def test_worker_calls_fenced_page_ingestion():
    from app.territory import search_plan
    task={**search_plan(config())[0],'page_number':0,'pending':[],'next_page_token':None}
    class FakeStore:
        def __init__(self):self.calls=[];self.work_count=0
        async def action(self,action,payload=None):
            self.calls.append((action,payload))
            if action=='claim':
                assert payload['protocol']==2 and payload['daily_target']==20
                return {'id':'scan','lease':'fence'}
            if action=='work':
                self.work_count+=1
                return {'done':False,'task':task} if self.work_count==1 else {'done':True,'outcome':'daily_target_reached'}
            return {'ok':True}
    class Provider:
        async def page(self,current):
            p=place();p['location']={'latitude':9.08,'longitude':7.47}
            return {'places':[p,{**p,'userRatingCount':9}]}
    store=FakeStore();await tick(config(),store,Provider())
    assert [x[0] for x in store.calls]==['claim','work','ingest','work','finish']
    payload=store.calls[2][1]
    assert payload['lease']=='fence' and len(payload['records'])==1 and payload['rejected']==1

async def test_worker_access_denial_persisted():
    from app.territory import search_plan
    class FakeStore:
        def __init__(self):self.calls=[]
        async def action(self,action,payload=None):
            self.calls.append((action,payload))
            if action=='claim':return {'id':'scan','lease':'fence'}
            if action=='work':return {'done':False,'task':{**search_plan(config())[0],'page_number':0,'pending':[]}}
    class Provider:
        async def page(self,task):raise ProviderError('provider_access_denied',86400)
    store=FakeStore();await tick(config(),store,Provider())
    assert store.calls[-1][0]=='fail' and store.calls[-1][1]['error']=='provider_access_denied'

def test_public_intake_missing_verification_never_saves(setup):
    cfg,app,c,calls,h=setup
    body={'name':'Test','email':'test@example.com','phone':'+2348000000000','city':'Abuja','address':'Test address','bill':100,'interest':'Home solar','notes':'','consent':True,'requestId':'11111111-1111-4111-8111-111111111111','turnstileToken':'test'}
    assert c.post('/v1/inquiries',json=body,headers={'origin':'http://127.0.0.1:3000'}).status_code==503
    assert not any(r.url.path.endswith('enqueue_lead') for r,b in calls)

def test_verified_public_intake_uses_secret_rpc():
    import json
    cfg=config(turnstile_secret_key='challenge-private-key',ip_hash_salt='s'*32)
    calls=[]
    def handler(request):
        calls.append(request)
        if request.url.host=='challenges.cloudflare.com':return httpx.Response(200,json={'success':True,'hostname':'127.0.0.1'})
        assert request.url.path=='/rest/v1/rpc/helios_backend'
        assert request.headers['apikey']==SECRET and 'authorization' not in request.headers
        body=json.loads(request.content)
        assert body['p_action']=='inquiry'
        assert body['p_payload']['lead']['consent'] is True
        assert 'turnstileToken' not in body['p_payload']['lead']
        assert len(body['p_payload']['ip_hash'])==64
        return httpx.Response(200,json='lead-id')
    body={'name':'Test','email':'test@example.com','phone':'+2348000000000','city':'Abuja','address':'Test address','bill':100,'interest':'Home solar','notes':'','consent':True,'requestId':'11111111-1111-4111-8111-111111111111','turnstileToken':'challenge'}
    with TestClient(create_app(cfg,http_transport=httpx.MockTransport(handler))) as c:
        response=c.post('/v1/inquiries',json=body,headers={'origin':'http://127.0.0.1:3000'})
        assert response.status_code==201 and response.json()=={'received':True}
        assert SECRET not in response.text
    assert len(calls)==2

def test_provider_error_body_cannot_leak_secret():
    def handler(request):return httpx.Response(500,json={'message':SECRET})
    with TestClient(create_app(config(),http_transport=httpx.MockTransport(handler))) as c:
        response=c.get('/health/ready')
        assert response.status_code==503 and SECRET not in response.text

def test_review_count_and_rating_are_required():
    cfg=config()
    for field,value in [('rating',3.9),('userRatingCount',9),('rating',None),('userRatingCount',None)]:
        p=place();p[field]=value;assert not eligible(p,cfg)
    p=place();p['rating']=4;p['userRatingCount']=10;assert eligible(p,cfg)
    with pytest.raises(ValidationError):config(min_rating=3.5)
    with pytest.raises(ValidationError):config(min_review_count=9)

async def test_google_search_is_district_scoped_and_requests_quality_fields():
    from app.territory import search_plan
    cfg=config();cfg.google_places_api_key='test';task={**search_plan(cfg)[0],'page_number':0,'pending':[],'next_page_token':None}
    class Budget:
        async def action(self,action,payload):return {'allowed':True}
    def handler(request):
        import json
        body=json.loads(request.content)
        assert body['textQuery']=='businesses in Wuse II, Abuja, Nigeria'
        assert body['minRating']==4.0
        assert body['locationRestriction']['rectangle']['low']['latitude']==task['bounds']['south']
        assert 'places.rating' in request.headers['X-Goog-FieldMask']
        assert 'places.userRatingCount' in request.headers['X-Goog-FieldMask']
        return httpx.Response(200,json={'places':[]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        assert await Places(cfg,Budget(),{'id':'scan','lease':'fence'},client).page(task)=={'places':[]}

def test_rotation_plan_interleaves_districts_and_is_stable():
    from app.territory import search_plan,policy
    cfg=config();tasks=search_plan(cfg)
    assert len(tasks)==len(cfg.districts)*len(cfg.queries)
    assert tasks[0]['district']=='Wuse II' and tasks[1]['district']=='Maitama'
    assert len({task['key'] for task in tasks})==len(tasks)
    assert policy(cfg)['plan_hash']==policy(cfg)['plan_hash']
