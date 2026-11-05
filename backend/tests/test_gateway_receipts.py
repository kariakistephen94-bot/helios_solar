import hashlib,json
from datetime import datetime,timezone
import httpx
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app

def test_receipt_auth_precedes_parsing_and_never_routes_to_ai_or_sender():
    calls=[]
    def handler(request):
        calls.append(request)
        assert request.url.path=='/rest/v1/rpc/helios_gateway_receipt'
        return httpx.Response(200,json={'accepted':True,'duplicate':False})
    secret='separate-status-secret-value'
    cfg=Settings(_env_file=None,supabase_url='https://test.supabase.co',supabase_anon_key='anon',supabase_secret_key='sb_secret_test',gateway_status_webhook_secret=secret)
    body={'event':'message_status','provider':'linked_gateway','sender':'2348107920394','recipient':'2349138314501','message_id':'3EB0TEST0001','status':'read','occurred_at':datetime.now(timezone.utc).isoformat(),'timestamp_source':'provider'}
    body['event_id']='gwevt_'+hashlib.sha256(b'2348107920394:3EB0TEST0001:read').hexdigest()[:32]
    with TestClient(create_app(cfg,httpx.MockTransport(handler))) as c:
        path='/v1/integrations/gateway/message-status'
        assert c.post(path,content='not json').status_code==401
        assert not calls
        headers={'X-Helios-Gateway-Key':secret,'X-Helios-Event-ID':body['event_id']}
        assert c.post(path,headers=headers,json=body).status_code==200
        assert len(calls)==1
        assert c.post(path,headers={**headers,'X-Helios-Event-ID':'wrong'},json=body).status_code==422
        assert c.post(path,headers=headers,json={**body,'event_id':'gwevt_'+'0'*32}).status_code==422
        assert c.post(path,headers=headers,json={**body,'occurred_at':'2026-11-01T10:00:00'}).status_code==422
        assert c.post(path,headers=headers,json={**body,'recipient':'group@g.us'}).status_code==422
        assert c.post(path,headers=headers,content='x'*8200).status_code==413
        assert len(calls)==1
