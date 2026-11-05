"""Create fixed-template jobs automatically; does not dispatch messages."""
import asyncio
import logging
from uuid import uuid4
from .outreach import build_outreach_draft

log=logging.getLogger('helios.outreach')

async def enqueue_batch(store):
    candidates=await store.rpc('helios_outreach_automatic',{'p_action':'candidates','p_payload':{}})
    if candidates.get('error'):
        raise RuntimeError('automatic_queue_unavailable')
    count=0
    for prospect in candidates.get('items',[]):
        draft=build_outreach_draft(prospect['name'])
        result=await store.rpc('helios_outreach_automatic',{'p_action':'enqueue','p_payload':{
            'id':str(uuid4()),'prospect_id':prospect['id'],'prospect_version':prospect['version'],
            'draft_status':draft['status'],'business_name':draft.get('business_name') or prospect['name'],
            'message_text':draft['text'] or 'Message held: business name requires a recognizable short alias.',
        }})
        if not result.get('error'):count+=1
    return count

async def run_automatic_queue(store):
    failed=False
    while True:
        try:
            count=await enqueue_batch(store)
            if failed:log.info('automatic_queue_available')
            failed=False
        except asyncio.CancelledError:
            raise
        except Exception:
            if not failed:log.warning('automatic_queue_unavailable_apply_upgrade_or_check_database')
            failed=True
            count=0
        await asyncio.sleep(2 if count==50 else 30)
