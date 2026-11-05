"""Server-only linked-device gateway connection. No public send endpoint."""
import hmac
import httpx
from fastapi import Depends, Header, HTTPException

def register_gateway(app,cfg,transport=None):
    async def integration_auth(x_helios_key: str | None=Header(default=None)):
        expected=cfg.n8n_outreach_webhook_secret.get_secret_value()
        if not expected or not x_helios_key or not hmac.compare_digest(expected.encode(),x_helios_key.encode()):
            raise HTTPException(401,'Invalid integration credential')

    @app.get('/v1/integrations/n8n/gateway/status',dependencies=[Depends(integration_auth)])
    async def status():
        key=cfg.whatsapp_gateway_api_key.get_secret_value()
        if not key or not cfg.whatsapp_gateway_url:
            return {'connected':False,'status':'not_configured','provider':'linked_gateway'}
        async with httpx.AsyncClient(timeout=10,follow_redirects=False,transport=transport) as client:
            try:
                response=await client.get(cfg.whatsapp_gateway_url+'/status',headers={'Authorization':'Bearer '+key})
                if not response.is_success:
                    return {'connected':False,'status':'gateway_unavailable','provider':'linked_gateway'}
                data=response.json()
                return {'connected':data.get('connected') is True,
                        'status':'connected' if data.get('connected') is True else 'pairing_required' if data.get('needsQr') else 'disconnected',
                        'provider':'linked_gateway'}
            except (httpx.RequestError,ValueError):
                return {'connected':False,'status':'gateway_unavailable','provider':'linked_gateway'}
