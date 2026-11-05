"""Supabase HTTPS transport. No database URL, driver, or local storage."""
from datetime import datetime, timezone
import httpx

class StoreError(Exception):
    def __init__(self, code='supabase_unavailable', status=503):
        self.code,self.status=code,status
        super().__init__(code)

def now():
    return int(datetime.now(timezone.utc).timestamp())

class Store:
    def __init__(self,cfg,transport=None):
        self.cfg=cfg
        self.client=httpx.AsyncClient(base_url=cfg.supabase_url,timeout=20,follow_redirects=False,transport=transport)
    async def close(self): await self.client.aclose()
    async def request(self,method,path,*,admin=False,token=None,params=None,body=None,prefer=None):
        key=self.cfg.supabase_secret_key.get_secret_value() if admin else self.cfg.supabase_anon_key
        headers={'apikey':key}
        # Modern sb_secret keys belong in apikey, not Authorization. Legacy service_role JWTs need both.
        if token: headers['Authorization']='Bearer '+token
        elif admin and not key.startswith('sb_secret_'): headers['Authorization']='Bearer '+key
        if prefer: headers['Prefer']=prefer
        try:
            response=await self.client.request(method,path,headers=headers,params=params,json=body)
        except httpx.RequestError: raise StoreError() from None
        if not response.is_success:
            # Never expose provider error bodies, keys, URLs, or customer payloads.
            if not admin and response.status_code in (401,403):
                raise StoreError('workspace_access_denied',response.status_code)
            if admin and response.status_code==400:
                try: code=response.json().get('message','')
                except ValueError: code=''
                if code=='rate_limit': raise StoreError('rate_limit',429)
            raise StoreError() from None
        try: return response.json()
        except ValueError: raise StoreError('supabase_invalid_response') from None
    async def count(self,table,filters=None):
        if table not in {'leads','messages','appointments'}:raise StoreError('invalid_count_table')
        key=self.cfg.supabase_secret_key.get_secret_value()
        headers={'apikey':key,'Prefer':'count=exact','Range':'0-0'}
        if not key.startswith('sb_secret_'):headers['Authorization']='Bearer '+key
        try:
            response=await self.client.head('/rest/v1/'+table,headers=headers,params={'select':'id',**(filters or {})})
        except httpx.RequestError:raise StoreError() from None
        if not response.is_success:raise StoreError()
        try:return int(response.headers['content-range'].rsplit('/',1)[1])
        except (KeyError,ValueError):raise StoreError('count_unavailable') from None

    async def rpc(self,name,payload):
        return await self.request('POST','/rest/v1/rpc/'+name,admin=True,body=payload)
    async def action(self,action,payload=None):
        result=await self.rpc('helios_backend',{'p_action':action,'p_payload':payload or {}})
        if isinstance(result,dict) and result.get('error'):
            code=result['error']
            raise StoreError(code,{'not_found':404,'version_conflict':409,'daily_target_reached':409,'collector_upgrade_required':503,'collector_disabled':409,'collector_cooldown':429,'lease_lost':409}.get(code,503))
        return result
