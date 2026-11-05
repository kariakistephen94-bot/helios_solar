import {supabase} from './supabase';
export const apiOrigin=process.env.NEXT_PUBLIC_API_URL||process.env.NEXT_PUBLIC_PROSPECT_API_URL||(process.env.NODE_ENV==='development'?'http://127.0.0.1:8000':'');
export async function apiRequest<T=unknown>(path:string,method='GET',body?:unknown,authenticated=true):Promise<T>{
 if(!apiOrigin)throw new Error('The backend API address is not configured.');
 const token=authenticated?(await supabase?.auth.getSession())?.data.session?.access_token:undefined;
 if(authenticated&&!token)throw new Error('Sign in to access your workspace.');
 const response=await fetch(apiOrigin+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000),cache:'no-store'});
 if(!response.ok){const result=await response.json().catch(()=>null);throw new Error(typeof result?.detail==='string'?result.detail:'The backend could not complete this request. Please try again.');}
 return response.json() as Promise<T>;
}
