import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../components/NewProspectsTracker.tsx',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const mod=await import('data:text/javascript;base64,'+Buffer.from(js.replace(/from ['"]react\/jsx-runtime['"]/g,"from 'data:text/javascript,export const jsx=()=>null;export const jsxs=()=>null;export const Fragment=null'")).toString('base64'));
const base={enabled:true,configured:true,new_today:3,daily_target:20,target_timezone:'Africa/Lagos',active_district:'Wuse II',searches_remaining:8,requests_used:4,daily_request_limit:100,paused_until:0,next_scan_at:2000,worker_until:0};
const now=1000;

test('tracker reports each collector state honestly',()=>{
 assert.equal(mod.trackerStatus({...base,configured:false},now).label,'Google API key required');
 assert.equal(mod.trackerStatus({...base,enabled:false},now).tone,'warn');
 assert.equal(mod.trackerStatus({...base,new_today:20},now).label,'Daily target reached');
 assert.equal(mod.trackerStatus({...base,worker_until:now+60},now).label,'Scanning now');
 assert.match(mod.trackerStatus({...base,paused_until:now+60},now).label,/Cooling down/);
 assert.match(mod.trackerStatus({...base,searches_remaining:0},now).label,/No district searches/);
 assert.equal(mod.trackerStatus(base,now).label,'Waiting for the next scan');
});

test('an overdue scan is flagged as a possibly offline worker',()=>{
 assert.match(mod.trackerStatus({...base,next_scan_at:100},now+2000).label,/worker may be offline/);
 assert.equal(mod.trackerStatus({...base,next_scan_at:1000},now+500).label,'Waiting for the next scan');
 assert.equal(mod.trackerStatus({...base,next_scan_at:0},now+99999).label,'Waiting for the next scan');
});
