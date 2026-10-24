import {createClient} from 'npm:@supabase/supabase-js@2';
const allowed=(Deno.env.get('ALLOWED_ORIGINS')||'').split(',').map(s=>s.trim());
const secret=Deno.env.get('TURNSTILE_SECRET_KEY');
const salt=Deno.env.get('IP_HASH_SALT');
Deno.serve(async req=>{
 const origin=req.headers.get('origin')||'';
 const headers={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin','Content-Type':'application/json'};
 const respond=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers});
 if(!allowed.includes(origin))return new Response('Origin denied',{status:403});
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(req.method!=='POST')return respond(405,{error:'Method not allowed'});
 if(!secret||!salt)return respond(503,{error:'Intake is not configured'});
 try{
  // Stream-limit the body so chunked requests cannot bypass the limit.
  const reader=req.body?.getReader();if(!reader)return respond(400,{error:'Missing request'});
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16000){await reader.cancel();return respond(413,{error:'Request too large'})}chunks.push(value)}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  const body=JSON.parse(new TextDecoder().decode(bytes));
  for(const [key,max] of [['name',100],['email',180],['phone',30],['city',100],['address',240],['notes',2000]] as const){if(typeof body[key]!=='string'||body[key].length>max||(key!=='notes'&&!body[key].trim()))return respond(400,{error:'Invalid '+key});body[key]=body[key].trim()}
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)||body.phone.length<5||typeof body.bill!=='number'||!Number.isFinite(body.bill)||body.bill<=0||body.bill>10000||body.consent!==true||!['Home solar','Battery storage','Solar + battery'].includes(body.interest)||!/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(body.requestId))return respond(400,{error:'Invalid enquiry'});
  if(typeof body.turnstileToken!=='string'||body.turnstileToken.length>3000)return respond(400,{error:'Verification required'});
  const verify=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret,response:body.turnstileToken}),signal:AbortSignal.timeout(10000)});
  const verdict=await verify.json();
  const hostname=new URL(origin).hostname;
  if(!verdict.success||verdict.hostname!==hostname)return respond(403,{error:'Verification failed'});
  // Forwarded IP is used only for abuse throttling, never authentication.
  const ip=req.headers.get('x-forwarded-for')?.split(',')[0].trim()||'unknown';
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(salt+ip));
  const ipHash=Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join('');
  const envKeys=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}');
  const adminKey=envKeys.default||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if(!adminKey)return respond(503,{error:'Intake is not configured'});
  const db=createClient(Deno.env.get('SUPABASE_URL')!,adminKey);
  const {error}=await db.rpc('enqueue_lead',{p_request_id:body.requestId,p_ip_hash:ipHash,p_payload:{name:body.name,email:body.email,phone:body.phone,city:body.city,address:body.address,bill:body.bill,interest:body.interest,notes:body.notes,consent:true}});
  if(error)return respond(error.message.includes('rate_limit')?429:500,{error:error.message.includes('rate_limit')?'Too many requests. Try again later.':'Unable to save enquiry'});
  return respond(201,{received:true});
 }catch{return respond(400,{error:'Unable to process request'})}
});
