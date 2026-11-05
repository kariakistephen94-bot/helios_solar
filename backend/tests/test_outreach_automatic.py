import asyncio
from app.outreach_automatic import enqueue_batch

def test_automatic_messages_need_no_owner_lookup_or_model():
    class Store:
        def __init__(self):self.enqueued=[]
        async def rpc(self,name,payload):
            assert name=='helios_outreach_automatic'
            if payload['p_action']=='candidates':
                return {'items':[{'id':'test','name':'Sunrise Hotel Limited','phone':'08107920394','version':1}]}
            self.enqueued.append(payload['p_payload']);return {'status':'queued'}
    store=Store()
    assert asyncio.run(enqueue_batch(store))==1
    assert store.enqueued[0]['business_name']=='Sunrise Hotel'
    assert 'at Sunrise Hotel?' in store.enqueued[0]['message_text']
    assert store.enqueued[0]['draft_status']=='draft'
