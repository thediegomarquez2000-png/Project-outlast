import { getCache } from '@vercel/functions';
import { get, put, BlobPreconditionFailedError } from '@vercel/blob';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { Scope, Snapshot } from './model';
import seed from './history-seed.json';
const namespace='outlast-command:prj_Gyegycg7aYXaI2ft0qnSLFCNcTOH';
export async function readFeedCache<T>(key:string):Promise<T|undefined>{
 if(!process.env.VERCEL)return undefined;
 try{const value=await getCache({namespace}).get(key);if(typeof value!=='string')return undefined;return JSON.parse(gunzipSync(Buffer.from(value,'base64')).toString('utf8')) as T;}catch{return undefined;}
}
export async function writeFeedCache(key:string,value:unknown){
 if(!process.env.VERCEL)return;
 try{const packed=gzipSync(JSON.stringify(value)).toString('base64');if(packed.length<1900000)await getCache({namespace}).set(key,packed,{ttl:86400,tags:['outlast-feeds'],name:'official-feed-response'});}catch{}
}
const warmHistory=new Map<Scope,{points:Snapshot[];persisted:boolean}>();
const historyWrites=new Map<Scope,Promise<{history:Snapshot[];historyPersistent:boolean}>>();
export function mergeObservations(scope:Scope,current:Snapshot,old:Snapshot[]=[]){
 const cutoff=current.time-7*86400000,byTime=new Map<number,Snapshot>();
 for(const p of [...seed.filter(p=>p.scope===scope),...old,current])if(Number.isFinite(p.time)&&p.time>=cutoff&&p.time<=current.time&&Number.isFinite(p.coverage)&&(p.score===null||Number.isFinite(p.score)))byTime.set(p.time,{time:p.time,score:p.score,coverage:p.coverage,sectors:p.sectors});
 return [...byTime.values()].sort((a,b)=>a.time-b.time).slice(-2017);
}
export async function recordObservation(scope:Scope,current:Snapshot):Promise<{history:Snapshot[];historyPersistent:boolean}>{
 const running=historyWrites.get(scope);if(running)await running;
 const saved=warmHistory.get(scope);if(saved?.points.some(p=>p.time===current.time))return {history:saved.points,historyPersistent:saved.persisted};
 const task=(async()=>{
  let points=mergeObservations(scope,current,saved?.points);
  if(process.env.BLOB_STORE_ID||process.env.BLOB_READ_WRITE_TOKEN){
   for(let attempt=0;attempt<3;attempt++)try{
    const file=await get('history/'+scope+'.json',{access:'private',useCache:false});let existing:Snapshot[]=[];
    if(file?.statusCode===200){const content=JSON.parse(await new Response(file.stream).text());if(!Array.isArray(content.points))throw new Error('History storage format changed');existing=content.points;}
    points=mergeObservations(scope,current,existing);
    if(!existing.some(p=>p.time===current.time))await put('history/'+scope+'.json',JSON.stringify({version:1,scope,points}),{access:'private',addRandomSuffix:false,allowOverwrite:true,contentType:'application/json',cacheControlMaxAge:60,...(file?.statusCode===200?{ifMatch:file.blob.etag}:{})});
    warmHistory.set(scope,{points,persisted:true});return {history:points,historyPersistent:true};
   }catch(error){if(error instanceof BlobPreconditionFailedError&&attempt<2)continue;break;}
  }
  warmHistory.set(scope,{points,persisted:false});return {history:points,historyPersistent:false};
 })();
 historyWrites.set(scope,task);try{return await task;}finally{historyWrites.delete(scope);}
}
