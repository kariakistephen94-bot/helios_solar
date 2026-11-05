from datetime import datetime,timezone
import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app
from app.calendar import central_time

ID='11111111-1111-4111-8111-111111111111'
ACTOR='22222222-2222-4222-8222-222222222222'
AUTH={'Authorization':'Bearer staff-user-token'}

def client_for(calendar_result=None,missing=False):
    calls=[]
    def handler(request):
        import json
        body=json.loads(request.content) if request.content else {}
        calls.append((str(request.url.path),body))
        if request.url.path=='/auth/v1/user':return httpx.Response(200,json={'id':ACTOR})
        if request.url.path=='/rest/v1/staff_members':return httpx.Response(200,json=[{'user_id':ACTOR}])
        if request.url.path=='/rest/v1/appointments':return httpx.Response(200,json=[{
            'id':ID,'lead_id':ID,'starts_at':'2026-11-03T16:00:00+00:00',
            'ends_at':'2026-11-03T16:30:00+00:00','timezone':'America/Chicago','status':'confirmed','google_event_id':'existing'}])
        if request.url.path=='/rest/v1/rpc/helios_calendar':
            return httpx.Response(404 if missing else 200,json={} if missing else calendar_result or {'events':[]})
        if request.url.path=='/rest/v1/rpc/helios_backend':return httpx.Response(200,json={'protocol':2})
        if request.url.path=='/rest/v1/messages':return httpx.Response(200,json=[])
        return httpx.Response(404,json={})
    cfg=Settings(_env_file=None,supabase_url='https://test.supabase.co',supabase_anon_key='anon',supabase_secret_key='sb_secret_test')
    return TestClient(create_app(cfg,httpx.MockTransport(handler))),calls

def body(**changes):
    return {'id':ID,'title':'Battery consultation','event_type':'consultation','lead_id':None,
            'start_local':'2026-11-05T11:00','end_local':'2026-11-05T11:30','notes':'','status':'scheduled','version':1,**changes}

def test_calendar_requires_staff_authentication():
    c,_=client_for()
    with c:
        assert c.get('/v1/calendar?after=2026-11-01T00:00:00Z&before=2026-12-01T00:00:00Z').status_code in (401,403)
        assert c.post('/v1/calendar',json=body()).status_code in (401,403)

def test_calendar_lists_existing_bookings_when_upgrade_missing():
    c,_=client_for(missing=True)
    with c:
        r=c.get('/v1/calendar?after=2026-11-01T00:00:00Z&before=2026-12-01T00:00:00Z',headers=AUTH)
        assert r.status_code==200
        assert r.json()['writable'] is False
        assert r.json()['events'][0]['editable'] is False
        assert r.json()['events'][0]['status']=='scheduled'

def test_calendar_converts_central_time_and_binds_staff_actor():
    c,calls=client_for({'event':{'id':ID}})
    with c:
        assert c.post('/v1/calendar',headers=AUTH,json=body()).status_code==201
        sent=[payload for path,payload in calls if path.endswith('helios_calendar')][0]['p_payload']
        assert sent['starts_at']=='2026-11-05T17:00:00+00:00'
        assert sent['ends_at']=='2026-11-05T17:30:00+00:00'
        assert sent['actor']==ACTOR

@pytest.mark.parametrize('value',['2026-03-08T02:30','2026-11-01T01:30','not-a-date'])
def test_dst_and_invalid_local_time_rejected(value):
    with pytest.raises(HTTPException):central_time(value)

def test_calendar_rejects_bad_ranges_and_mismatched_ids():
    c,_=client_for()
    with c:
        assert c.get('/v1/calendar?after=2026-11-01T00:00:00&before=2026-12-01T00:00:00',headers=AUTH).status_code==422
        assert c.get('/v1/calendar?after=2026-01-01T00:00:00Z&before=2026-12-01T00:00:00Z',headers=AUTH).status_code==422
        assert c.post('/v1/calendar',json=body(end_local='2026-11-05T10:00'),headers=AUTH).status_code==422
        assert c.patch('/v1/calendar/'+ACTOR,json=body(),headers=AUTH).status_code==422

def test_calendar_conflicts_are_recoverable():
    c,_=client_for({'error':'slot_conflict'})
    with c:
        r=c.post('/v1/calendar',headers=AUTH,json=body())
        assert r.status_code==409
        assert 'overlaps' in r.json()['detail']

def test_connections_and_message_history_require_staff():
    c,_=client_for()
    with c:
        assert c.get('/v1/connections').status_code in (401,403)
        assert c.get('/v1/leads/'+ID+'/messages').status_code in (401,403)
        assert c.get('/v1/connections',headers=AUTH).json()['supabase'] is True
        assert c.get('/v1/leads/'+ID+'/messages',headers=AUTH).json()=={'messages':[]}
