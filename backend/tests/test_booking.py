import json
from datetime import datetime,timedelta
from zoneinfo import ZoneInfo
import httpx
import pytest
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app

HEADERS={'Origin':'http://127.0.0.1:3000'}
def next_slot():
    today=datetime.now(ZoneInfo('America/Chicago'))
    return (today+timedelta(days=7-today.weekday())).replace(hour=10,minute=0,second=0,microsecond=0).strftime('%Y-%m-%dT%H:%M')

def setup_client(conflict=False):
    calls=[]
    def handler(request):
        body=json.loads(request.content)
        calls.append((request.url.path,body))
        if request.url.path=='/v1/responses':
            args={'start_local':next_slot(),'name':'Test Visitor','email':'test@example.com','notes':'Battery consultation'}
            return httpx.Response(200,json={'status':'completed','output':[{'type':'function_call','name':'prepare_consultation','arguments':json.dumps(args),'call_id':'call-test'}]})
        if request.url.path=='/rest/v1/rpc/helios_website_booking':
            if body['p_action']=='availability':return httpx.Response(200,json={'available':True})
            if conflict:return httpx.Response(200,json={'error':'slot_conflict'})
            payload=body['p_payload']
            return httpx.Response(200,json={'event':{'id':payload['request_id'],'starts_at':payload['starts_at'],
                'ends_at':(datetime.fromisoformat(payload['starts_at'])+timedelta(minutes=30)).isoformat(),
                'status':'scheduled','timezone':'America/Chicago'}})
        return httpx.Response(404,json={})
    cfg=Settings(_env_file=None,supabase_url='https://test.supabase.co',supabase_anon_key='anon',supabase_secret_key='sb_secret_test',openai_api_key='sk-mocked',ip_hash_salt='test-only-secret-value-that-is-long-enough')
    return TestClient(create_app(cfg,httpx.MockTransport(handler))),calls

def proposal(client,text='My name is Test Visitor and my email is test@example.com. Book a battery consultation.'):
    return client.post('/v1/chat',headers=HEADERS,json={'messages':[{'role':'user','content':text}]})

def test_proposal_never_writes_and_confirmation_is_explicit():
    c,calls=setup_client()
    with c:
        p=proposal(c)
        assert p.status_code==200
        assert p.json()['booking']['email']=='test@example.com'
        assert not any(body.get('p_action')=='confirm' for _,body in calls)
        token=p.json()['booking']['token']
        assert c.post('/v1/chat/booking/confirm',headers=HEADERS,json={'token':token,'consent':False}).status_code==422
        result=c.post('/v1/chat/booking/confirm',headers=HEADERS,json={'token':token,'consent':True})
        assert result.status_code==200
        assert result.json()['appointment']['status']=='scheduled'
        assert 'booked' in result.json()['reply']

def test_forged_token_and_wrong_origin_never_write():
    c,calls=setup_client()
    with c:
        token=proposal(c).json()['booking']['token']
        assert c.post('/v1/chat/booking/confirm',headers=HEADERS,json={'token':token+'bad','consent':True}).status_code==400
        assert c.post('/v1/chat/booking/confirm',headers={'Origin':'https://other.test'},json={'token':token,'consent':True}).status_code==403
        assert not any(body.get('p_action')=='confirm' for _,body in calls)

def test_ai_cannot_invent_contact_details():
    c,calls=setup_client()
    with c:
        result=proposal(c,'Please book me a consultation.')
        assert 'booking' not in result.json()
        assert not any(path.endswith('helios_website_booking') for path,_ in calls)

def test_confirmation_rechecks_conflicts():
    c,calls=setup_client(conflict=True)
    with c:
        token=proposal(c).json()['booking']['token']
        result=c.post('/v1/chat/booking/confirm',headers=HEADERS,json={'token':token,'consent':True})
        assert result.status_code==409
        assert 'no longer available' in result.json()['detail']
        assert 'appointment' not in result.json()

def test_expired_confirmation_is_rejected(monkeypatch):
    c,calls=setup_client()
    with c:
        token=proposal(c).json()['booking']['token']
        import app.booking
        original=app.booking.time.time
        monkeypatch.setattr(app.booking.time,'time',lambda:original()+1000)
        result=c.post('/v1/chat/booking/confirm',headers=HEADERS,json={'token':token,'consent':True})
        assert result.status_code==409
        assert 'expired' in result.json()['detail']

def test_tool_rejects_out_of_hours():
    from app.booking import slot
    from fastapi import HTTPException
    bad=next_slot().split('T')[0]+'T23:30'
    with pytest.raises(HTTPException):slot(bad)
