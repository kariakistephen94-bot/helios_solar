"""Staff-reviewed draft queue. No dispatch or provider calls."""
from uuid import UUID
from fastapi import Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from .outreach import build_outreach_draft, clean


class CreateDraft(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: UUID
    prospect_id: UUID
    owner_name: str | None = Field(default=None, max_length=60)
    short_business_name: str | None = Field(default=None, max_length=40)


class Revision(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: int = Field(ge=1)


def register_outreach_queue(app, store, auth):
    async def action(name, payload):
        result = await store.rpc('helios_outreach', {'p_action': name, 'p_payload': payload})
        if result.get('error'):
            code = result['error']
            status = {'not_found': 404, 'staff_required': 403, 'version_conflict': 409,
                      'request_conflict': 409, 'invalid_transition': 409}.get(code, 400)
            raise HTTPException(status, code.replace('_', ' '))
        return result

    @app.get('/v1/outreach/activity')
    async def activity(status: str = Query('all', pattern='^(all|accepted|failed|unknown|reserved|replied|delivered|read)$'),
                       limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0, le=100000), actor=Depends(auth)):
        result = await store.rpc('helios_outreach_activity', {'p_actor':actor,'p_status':status,'p_limit':limit,'p_offset':offset})
        if result.get('error'):
            raise HTTPException(403 if result['error']=='staff_required' else 400, 'Unable to read outreach activity')
        return result

    @app.get('/v1/outreach/jobs')
    async def jobs(limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0, le=100000), actor=Depends(auth)):
        return await action('list', {'actor': actor, 'limit': limit, 'offset': offset})

    @app.post('/v1/outreach/jobs')
    async def create(body: CreateDraft, actor=Depends(auth)):
        row = await action('prospect', {'actor': actor, 'prospect_id': str(body.prospect_id)})
        prospect = row['prospect']
        draft = build_outreach_draft(prospect['name'], body.owner_name, body.short_business_name)
        if draft['status'] != 'draft':
            raise HTTPException(422, draft['reason'])
        return await action('create', {'actor': actor, 'id': str(body.request_id),
            'prospect_id': prospect['id'], 'prospect_version': prospect['version'],
            'message_text': draft['text'], 'business_name': draft['business_name'],
            'owner_name': clean(body.owner_name or '') or None,
            'template_version': draft['template_version']})

    @app.post('/v1/outreach/jobs/{job_id}/review')
    async def review(job_id: UUID, body: Revision, actor=Depends(auth)):
        return await action('review', {'actor': actor, 'id': str(job_id), 'version': body.version})

    @app.post('/v1/outreach/jobs/{job_id}/cancel')
    async def cancel(job_id: UUID, body: Revision, actor=Depends(auth)):
        return await action('cancel', {'actor': actor, 'id': str(job_id), 'version': body.version})
