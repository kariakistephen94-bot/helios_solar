from datetime import datetime, timezone
import httpx
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app
from app.outreach import build_outreach_draft, shorten_business_name


def test_name_rules_preserve_brand_and_require_review_for_ambiguity():
    assert shorten_business_name('Sunrise Hotel Limited')['name'] == 'Sunrise Hotel'
    assert shorten_business_name('Sunrise Hotel - Wuse Branch')['name'] == 'Sunrise Hotel'
    assert shorten_business_name('Sunrise Hotel (Wuse Branch)')['name'] == 'Sunrise Hotel'
    assert shorten_business_name('LTD Design')['name'] == 'LTD Design'
    assert shorten_business_name('A Very Long And Distinctive Business Trading Name With Many Words')['needs_review']
    assert shorten_business_name(' \n\t ')['needs_review']


def test_greetings_follow_lagos_not_server_time():
    for utc_hour, expected in [(8, 'morning'), (11, 'afternoon'), (16, 'evening')]:
        result = build_outreach_draft('Sunrise Hotel Ltd', now=datetime(2026, 10, 31, utc_hour, tzinfo=timezone.utc))
        assert result['text'].startswith(f'Hello, good {expected}.\n\n')
        assert len(result['text'].split('\n\n')) == 4
        assert result['sent'] is False


def test_explicit_owner_and_curated_alias():
    result = build_outreach_draft('Long original business name', 'Stephen', 'Sunrise Hotel')
    assert result['text'].startswith('Hi Stephen,\n\n')
    assert 'at Sunrise Hotel?' in result['text']
    assert 'Long original' not in result['text']


def test_preview_is_staff_only_and_never_calls_provider_or_database_write():
    calls = []
    def handler(request):
        calls.append(request.url.path)
        if request.url.path == '/auth/v1/user':
            return httpx.Response(200, json={'id': 'staff-user'})
        if request.url.path == '/rest/v1/staff_members':
            return httpx.Response(200, json=[{'user_id': 'staff-user'}])
        raise AssertionError('Draft generation must not call messaging, AI, or storage providers')
    cfg = Settings(_env_file=None, supabase_url='https://test.supabase.co',
                   supabase_anon_key='anon', supabase_secret_key='sb_secret_test')
    with TestClient(create_app(cfg, httpx.MockTransport(handler))) as client:
        assert client.post('/v1/outreach/preview', json={'business_name': 'Hotel'}).status_code in (401, 403)
        assert not calls
        result = client.post('/v1/outreach/preview', headers={'Authorization': 'Bearer staff-token'},
                             json={'business_name': 'Sunrise Hotel Limited'})
        assert result.status_code == 200
        assert result.json()['status'] == 'draft'
        assert len(calls) == 2
