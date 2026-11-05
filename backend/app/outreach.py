"""Deterministic outreach drafts. No model calls or message delivery."""
import re
import unicodedata
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import Depends
from pydantic import BaseModel, ConfigDict, Field

LAGOS = ZoneInfo('Africa/Lagos')
MAX_BRAND_LENGTH = 40
LEGAL_SUFFIX = re.compile(
    r'(?:,?\s+)(?:limited|ltd\.?|plc\.?|llc\.?|inc\.?|incorporated|'
    r'corporation|corp\.?)(?:\s*)$', re.IGNORECASE
)
BRANCH = re.compile(
    r'\s+(?:\||[–—]|-)\s+[^\n]*(?:branch|outlet|location)\s*$', re.IGNORECASE
)


def clean(value: str) -> str:
    # Remove invisible controls, then normalize whitespace for a single-line slot.
    value = unicodedata.normalize('NFKC', value)
    value = ''.join(c if not unicodedata.category(c).startswith('C') else ' ' for c in value)
    return ' '.join(value.split()).strip()


def shorten_business_name(value: str) -> dict:
    original = clean(value)
    candidate = BRANCH.sub('', original).strip()
    while True:
        shortened = LEGAL_SUFFIX.sub('', candidate).strip(' ,')
        if shortened == candidate:
            break
        candidate = shortened
    # Only explicit branch labels are safe to discard without a curated alias.
    candidate = re.sub(r'\s*\([^()]*\b(?:branch|outlet|location)\)\s*$', '', candidate, flags=re.I).strip()
    if not candidate or len(candidate) > MAX_BRAND_LENGTH:
        return {'name': None, 'needs_review': True,
                'reason': 'Set a recognizable short business name; automatic shortening is ambiguous.'}
    return {'name': candidate, 'needs_review': False, 'reason': None}


def build_outreach_draft(business_name: str, owner_name: str | None = None,
                         short_business_name: str | None = None,
                         now: datetime | None = None) -> dict:
    now = now or datetime.now(LAGOS)
    if now.tzinfo is None:
        raise ValueError('A timezone-aware date is required')
    local = now.astimezone(LAGOS)
    brand = shorten_business_name(short_business_name or business_name)
    owner = clean(owner_name or '')
    if len(owner) > 60:
        return {'status': 'needs_review', 'text': None, 'reason': 'Check the owner name.'}
    if brand['needs_review']:
        return {'status': 'needs_review', 'text': None, 'reason': brand['reason']}
    period = 'morning' if local.hour < 12 else 'afternoon' if local.hour < 17 else 'evening'
    greeting = f'Hi {owner},' if owner else f'Hello, good {period}.'
    text = (
        f'{greeting}\n\n'
        f"Tired of grid outages and high generator bills at {brand['name']}?\n\n"
        'We help local businesses install custom solar systems for reliable, '
        '24/7 power you control.\n\n'
        'Open to a quick chat this week?'
    )
    return {'status': 'draft', 'text': text, 'business_name': brand['name'],
            'timezone': 'Africa/Lagos', 'template_version': 'solar-introduction-v1',
            'personalization': 'rules_only', 'sent': False}


class DraftRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    business_name: str = Field(min_length=1, max_length=500)
    # Supply only a known owner name. Never infer it from the business name.
    owner_name: str | None = Field(default=None, max_length=100)
    short_business_name: str | None = Field(default=None, max_length=40)


def register_outreach(app, auth):
    @app.post('/v1/outreach/preview')
    async def preview(body: DraftRequest, actor=Depends(auth)):
        return build_outreach_draft(**body.model_dump())
