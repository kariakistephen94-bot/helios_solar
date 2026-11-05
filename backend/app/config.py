from functools import lru_cache
from pydantic import model_validator, Field, AliasChoices, SecretStr
from .territory import DISTRICTS
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', extra='ignore', hide_input_in_errors=True)
    environment: str = 'development'
    whatsapp_gateway_url: str = ''
    whatsapp_gateway_api_key: SecretStr = SecretStr('')
    gateway_status_webhook_secret: SecretStr = SecretStr('')
    outreach_automatic_enabled: bool = False
    outreach_dispatch_enabled: bool = False
    outreach_test_delivery_enabled: bool = False
    gateway_test_delivery_enabled: bool = False
    openai_api_key: SecretStr = SecretStr('')
    openai_chat_model: str = 'gpt-4.1-mini'
    n8n_outreach_webhook_secret: SecretStr = SecretStr('')
    n8n_outreach_webhook_url: str = ''
    google_places_api_key: str = ''
    turnstile_secret_key: str = ''
    ip_hash_salt: str = ''
    cors_origins: list[str] = ['http://127.0.0.1:3002', 'http://localhost:3002']
    supabase_url: str = ''
    supabase_anon_key: str = Field(default='', validation_alias=AliasChoices('SUPABASE_ANON_KEY','SUPABASE_PUBLISHABLE_KEY','supabase_anon_key'))
    supabase_secret_key: SecretStr = Field(default=SecretStr(''), validation_alias=AliasChoices('SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY','supabase_secret_key'))
    daily_new_target: int = 20
    min_rating: float = 4.0
    min_review_count: int = 10
    revisit_hours: int = 168
    districts: list[dict] = Field(default_factory=lambda:[dict(d) for d in DISTRICTS])
    scan_interval_hours: int = 24
    daily_request_limit: int = 100
    request_spacing_seconds: float = 2.0
    max_pages: int = 3
    # Explicit urban Abuja pilot rectangle, NOT an official FCT administrative boundary.
    south: float = 8.95
    north: float = 9.18
    west: float = 7.25
    east: float = 7.60
    queries: list[str] = ['businesses', 'hotels', 'restaurants', 'schools', 'clinics', 'supermarkets', 'offices', 'shops', 'workshops', 'warehouses']

    @model_validator(mode='after')
    def validate_config(self):
        if not 1 <= self.scan_interval_hours <= 720 or not 1 <= self.daily_request_limit <= 10000:
            raise ValueError('Invalid schedule or request budget')
        if not 1 <= self.max_pages <= 3 or not 1 <= self.request_spacing_seconds <= 10:
            raise ValueError('Invalid pagination or request spacing')
        if not (8.5 <= self.south < self.north <= 9.5 and 6.8 <= self.west < self.east <= 8.0):
            raise ValueError('Territory must remain in the Abuja pilot area')
        if not self.queries or len(self.queries) > 50 or any(not q.strip() or len(q)>100 for q in self.queries):
            raise ValueError('Invalid search queries')
        if not 1 <= self.daily_new_target <= 200 or not 4 <= self.min_rating <= 5 or not 10 <= self.min_review_count <= 100000:
            raise ValueError('Require a daily target of 1–200, at least 4.0 stars and at least 10 ratings')
        if not 24 <= self.revisit_hours <= 2160 or not 1 <= len(self.districts) <= 30:
            raise ValueError('Invalid district rotation settings')
        names=set()
        for d in self.districts:
            if set(d) != {'name','south','north','west','east'} or not isinstance(d['name'],str) or not d['name'].strip() or len(d['name'])>80 or d['name'] in names:
                raise ValueError('Invalid or duplicate district')
            names.add(d['name'])
            if not (self.south <= d['south'] < d['north'] <= self.north and self.west <= d['west'] < d['east'] <= self.east):
                raise ValueError('District search windows must stay inside the Abuja pilot')
        from urllib.parse import urlparse
        parsed = urlparse(self.supabase_url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.path not in ('','/') or parsed.query or parsed.fragment or parsed.username:
            raise ValueError('SUPABASE_URL must be an HTTPS project origin')
        self.supabase_url = self.supabase_url.rstrip('/')
        if not self.supabase_anon_key or not self.supabase_secret_key.get_secret_value():
            raise ValueError('SUPABASE_ANON_KEY and SUPABASE_SECRET_KEY are required')
        if self.supabase_anon_key.startswith('sb_secret_') or self.supabase_anon_key == self.supabase_secret_key.get_secret_value():
            raise ValueError('Use distinct public anon and private secret keys')
        if '*' in self.cors_origins:
            raise ValueError('Explicit dashboard origins are required')
        if self.environment == 'production' and any(not x.startswith('https://') for x in self.cors_origins):
            raise ValueError('Production requires explicit HTTPS dashboard origins')
        return self

@lru_cache
def settings():
    return Settings()
