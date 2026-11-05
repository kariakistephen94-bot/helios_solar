"""Explicit pilot search windows, not official administrative boundaries."""
import hashlib
import json

DISTRICTS=[
 {'name':'Wuse II','south':9.075,'north':9.095,'west':7.455,'east':7.490},
 {'name':'Maitama','south':9.095,'north':9.130,'west':7.460,'east':7.515},
 {'name':'Asokoro','south':9.025,'north':9.065,'west':7.510,'east':7.560},
 {'name':'Garki','south':9.015,'north':9.055,'west':7.455,'east':7.505},
 {'name':'Jabi','south':9.055,'north':9.090,'west':7.400,'east':7.440},
 {'name':'Utako','south':9.055,'north':9.085,'west':7.425,'east':7.455},
 {'name':'Gwarinpa','south':9.095,'north':9.150,'west':7.375,'east':7.430},
 {'name':'Wuye','south':9.025,'north':9.065,'west':7.415,'east':7.455},
 {'name':'Guzape','south':8.985,'north':9.035,'west':7.485,'east':7.535},
 {'name':'Kado','south':9.085,'north':9.115,'west':7.410,'east':7.450},
]

def search_plan(cfg):
    tasks=[]
    # Districts alternate before the next category, avoiding a whole-city sweep.
    for category in cfg.queries:
        for district in cfg.districts:
            bounds={k:district[k] for k in ('south','north','west','east')}
            data={'district':district['name'],'category':category,'bounds':bounds}
            key=hashlib.sha256(json.dumps(data,sort_keys=True).encode()).hexdigest()
            tasks.append({'key':key,**data,'position':len(tasks)})
    return tasks

def policy(cfg):
    tasks=search_plan(cfg)
    return {'protocol':2,'plan_hash':hashlib.sha256(json.dumps(tasks,sort_keys=True).encode()).hexdigest(),
            'tasks':tasks,'daily_target':cfg.daily_new_target,'min_rating':cfg.min_rating,
            'min_reviews':cfg.min_review_count,'revisit_hours':cfg.revisit_hours,'max_pages':cfg.max_pages,
            'interval_hours':cfg.scan_interval_hours}
