import asyncio
import hashlib
import json
import logging
from .collector import Places,ProviderError,prepare
from .config import settings
from .db import Store
from .territory import policy
log=logging.getLogger('helios.worker')

async def tick(cfg,store,provider=None):
    job=await store.action('claim',policy(cfg))
    if not job:return
    fence={'job_id':job['id'],'lease':job['lease'],'protocol':2}
    source=provider or Places(cfg,store,job)
    try:
        while True:
            work=await store.action('work',fence)
            if work.get('done'):
                await store.action('finish',{**fence,'outcome':work['outcome']})
                return
            task=work['task']
            if task.get('pending'):
                records=task['pending'];rejected=0;next_token=task.get('next_page_token');pending=True
            else:
                try:page=await source.page(task)
                except ProviderError as exc:
                    if exc.code=='pagination_token_expired':
                        await store.action('reset_page',{**fence,'task_key':task['key']})
                        continue
                    raise
                prepared=[prepare(p,cfg,task) for p in page.get('places',[])]
                records=[p for p in prepared if p]
                rejected=len(prepared)-len(records)
                next_token=page.get('nextPageToken');pending=False
            payload={**fence,'task_key':task['key'],'records':records,'rejected':rejected,
                     'next_page_token':next_token,'from_pending':pending}
            payload['batch_id']=hashlib.sha256(json.dumps({'key':task['key'],'page':task['page_number'],'records':records,'pending':pending,'token':next_token},sort_keys=True).encode()).hexdigest()
            await store.action('ingest',payload)
    except Exception as exc:
        code=exc.code if isinstance(exc,ProviderError) else 'internal_collection_error'
        delay=exc.delay if isinstance(exc,ProviderError) else 300
        log.error('scan_failed job=%s code=%s',job['id'],code)
        try:await store.action('fail',{**fence,'error':code,'delay':delay})
        except Exception:log.error('scan_failure_persistence_unavailable')

async def main():
    cfg=settings();store=Store(cfg)
    try:
        while True:
            try:await tick(cfg,store)
            except Exception:log.error('worker_tick_unavailable')
            await asyncio.sleep(10)
    finally:await store.close()

if __name__=='__main__':
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
