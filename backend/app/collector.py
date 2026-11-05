"""Licensed Google Places connector. No browser automation or anti-detection measures."""
import asyncio
import hashlib
import random
import re
import unicodedata
from datetime import datetime, timezone
import httpx
from .db import now

class ProviderError(Exception):
    def __init__(self, code, delay=300):
        self.code, self.delay = code, delay
        super().__init__(code)

def normalize(s):
    return re.sub(r'[^\w]+', '', unicodedata.normalize('NFKC', s).casefold())

def eligible(p, cfg, task=None):
    loc = p.get('location', {})
    lat, lng = loc.get('latitude'), loc.get('longitude')
    country = next((x.get('shortText') for x in p.get('addressComponents', []) if 'country' in x.get('types', [])), None)
    bounds=task['bounds'] if task else {'south':cfg.south,'north':cfg.north,'west':cfg.west,'east':cfg.east}
    rating,count=p.get('rating'),p.get('userRatingCount')
    return (isinstance(rating,(int,float)) and not isinstance(rating,bool) and cfg.min_rating <= rating <= 5
            and isinstance(count,int) and not isinstance(count,bool) and count >= cfg.min_review_count
            and isinstance(lat, (int, float)) and isinstance(lng, (int, float))
            and bounds['south'] <= lat <= bounds['north'] and bounds['west'] <= lng <= bounds['east']
            and country == 'NG' and p.get('businessStatus') == 'OPERATIONAL'
            and bool(p.get('internationalPhoneNumber') or p.get('websiteUri'))
            and bool(p.get('id') and p.get('displayName', {}).get('text') and p.get('formattedAddress')))

def prepare(p,cfg,task=None):
    if not eligible(p,cfg,task): return None
    name,address=p['displayName']['text'][:300],p['formattedAddress'][:600]
    website=p.get('websiteUri','')
    return {'place_id':p['id'],'fingerprint':hashlib.sha256((normalize(name)+'|'+normalize(address)).encode()).hexdigest(),
            'name':name,'address':address,'phone':p.get('internationalPhoneNumber','')[:80],
            'website':website[:2000] if website.startswith(('http://','https://')) else '',
            'rating':p['rating'],'review_count':p['userRatingCount'],'district':task['district'] if task else None,
            'latitude':p['location']['latitude'],'longitude':p['location']['longitude'],'category':p.get('primaryType','business')[:120]}

class Places:
    def __init__(self,cfg,store,job,client=None):
        self.cfg,self.store,self.job,self.client=cfg,store,job,client
    async def reserve(self):
        result=await self.store.action('reserve',{'job_id':self.job['id'],'lease':self.job['lease'],'limit':self.cfg.daily_request_limit})
        if not result['allowed']:raise ProviderError('daily_request_budget_exhausted',result['retry_after'])
    async def request(self, client, body):
        for attempt in range(3):
            await self.reserve()
            await asyncio.sleep(self.cfg.request_spacing_seconds)
            try:
                response = await client.post('https://places.googleapis.com/v1/places:searchText', json=body,
                    headers={'X-Goog-Api-Key':self.cfg.google_places_api_key,
                             'X-Goog-FieldMask':'places.id,places.displayName,places.formattedAddress,places.addressComponents,places.location,places.internationalPhoneNumber,places.websiteUri,places.businessStatus,places.primaryType,places.rating,places.userRatingCount,nextPageToken'})
            except httpx.RequestError:
                if attempt == 2: raise ProviderError('provider_network_error') from None
                await asyncio.sleep(2 ** attempt + random.random()); continue
            if response.status_code in (401,403): raise ProviderError('provider_access_denied', 86400)
            if response.status_code == 429 or response.status_code >= 500:
                # Long Retry-After is persisted as a cooldown rather than holding a worker.
                retry = response.headers.get('Retry-After', '0')
                try: delay = max(0, int(retry))
                except ValueError:
                    from email.utils import parsedate_to_datetime
                    try: delay = max(0, int(parsedate_to_datetime(retry).timestamp()) - now())
                    except (ValueError, TypeError): delay = 60
                if delay > 10 or attempt == 2: raise ProviderError('provider_rate_limited' if response.status_code == 429 else 'provider_unavailable', max(300,delay))
                await asyncio.sleep(max(delay, 2 ** attempt + random.random())); continue
            if response.status_code==400 and body.get('pageToken'):raise ProviderError('pagination_token_expired',1)
            if response.status_code != 200: raise ProviderError('provider_request_rejected',86400)
            try: return response.json()
            except ValueError: raise ProviderError('provider_invalid_response') from None
        raise ProviderError('provider_unavailable')
    async def page(self,task):
        if not self.cfg.google_places_api_key: raise ProviderError('google_api_key_missing',3600)
        bounds=task['bounds']
        body={'textQuery':f"{task['category']} in {task['district']}, Abuja, Nigeria",'pageSize':20,
              'languageCode':'en','regionCode':'NG','minRating':self.cfg.min_rating,
              'locationRestriction':{'rectangle':{'low':{'latitude':bounds['south'],'longitude':bounds['west']},
                                                  'high':{'latitude':bounds['north'],'longitude':bounds['east']}}}}
        if task.get('next_page_token'):body['pageToken']=task['next_page_token']
        async with httpx.AsyncClient(timeout=30,follow_redirects=False) as default_client:
            result=await self.request(self.client or default_client,body)
        if not isinstance(result,dict) or not isinstance(result.get('places',[]),list) or len(result.get('places',[]))>20:
            raise ProviderError('provider_invalid_response')
        return result
