import { readFeedCache, writeFeedCache } from './storage';
import type { Source } from './model';
type CachedFeed={payload:string;fetchedAt:number;publishedAt?:number;maxPublicationAge?:number;connectionUrl:string;connectionLabel:string;usingFallback:boolean};
const memory=new Map<string,CachedFeed>();
const pending=new Map<string,Promise<CachedFeed>>();
const publicationDelayed=(row:CachedFeed)=>!!(row.publishedAt&&row.maxPublicationAge&&Date.now()-row.publishedAt>row.maxPublicationAge*1000);
const cachedResult=(row:CachedFeed):CachedFeed&{state:'fresh'|'stale';error?:string}=>({...row,state:publicationDelayed(row)?'stale':'fresh',...(publicationDelayed(row)?{error:'Provider publication is delayed; showing dated published records.'}:{})});
// Some official feeds (AWS Health) are served as UTF-16 with a byte-order mark; fetch's text() would assume UTF-8.
function decodeBody(bytes:Uint8Array){if(bytes.length>=2&&bytes[0]===0xfe&&bytes[1]===0xff){const swapped=new Uint8Array(bytes.length-2);for(let i=2;i+1<bytes.length;i+=2){swapped[i-2]=bytes[i+1];swapped[i-1]=bytes[i];}return new TextDecoder('utf-16le').decode(swapped);}if(bytes.length>=2&&bytes[0]===0xff&&bytes[1]===0xfe)return new TextDecoder('utf-16le').decode(bytes.subarray(2));const text=new TextDecoder('utf-8').decode(bytes);return text.charCodeAt(0)===0xfeff?text.slice(1):text;}
async function download(url:string){const response=await fetch(url,{headers:{'User-Agent':'OUTLAST-Command/2.0 (public infrastructure dashboard)','Accept':'application/json, application/xml, text/xml, text/html;q=0.8'},signal:AbortSignal.timeout(8500)});if(!response.ok)throw new Error(`Source returned HTTP ${response.status}`);const text=decodeBody(new Uint8Array(await response.arrayBuffer()));if(!text.trim()||text.length>6_000_000)throw new Error('Source returned an empty or oversized response');return text;}
function compact(text:string){if(/^[\s]*[\[{]/.test(text)){const d=JSON.parse(text);if(d.error)throw new Error(`Source query failed: ${String(d.error.message??d.error).slice(0,160)}`);if(d.exceededTransferLimit)throw new Error('Source response truncated; complete coverage unavailable');return JSON.stringify(d);}return text;}
export async function cachedFeed(source:Source,validate:(text:string)=>unknown):Promise<CachedFeed&{state:'fresh'|'stale';error?:string}>{
 const key=`v3:${source.id}`;let old=memory.get(key);
 if(!old){old=await readFeedCache<CachedFeed>(key);if(old){try{validate(old.payload);memory.set(key,old);}catch{old=undefined;}}}
 if(old&&Date.now()-old.fetchedAt<(source.interval??180)*1000)return cachedResult(old);
 try{let request=pending.get(key);if(!request){request=(async()=>{
  const connections=[{endpoint:source.endpoint!,label:source.id==='pge'?'Cal OES · utility-reported PG&E outages':source.name,extraEndpoints:source.extraEndpoints,metaUrl:source.metaUrl,maxAge:source.maxAge},...(source.fallbacks??[])];let lastError:unknown;let delayed:CachedFeed|undefined;
  for(let index=0;index<connections.length;index++){const candidate=connections[index];try{
   const [primary,extra,metadata]=await Promise.all([download(candidate.endpoint),Promise.all((candidate.extraEndpoints??[]).map(download)),candidate.metaUrl?download(candidate.metaUrl):Promise.resolve(null)]);
   let payload=compact(primary);if(extra.length){const d=JSON.parse(payload);if(!Array.isArray(d.features))throw new Error('Multi-layer source format changed');for(const piece of extra){const e=JSON.parse(compact(piece));if(!Array.isArray(e.features))throw new Error('Additional source layer missing');d.features.push(...e.features);}payload=JSON.stringify(d);}
   let publishedAt:number|undefined;if(metadata){const meta=JSON.parse(metadata);publishedAt=Number(meta.editingInfo?.lastEditDate)||undefined;if(!publishedAt)throw new Error('Publication heartbeat missing');}
   validate(payload);const row:CachedFeed={payload,fetchedAt:Date.now(),publishedAt,maxPublicationAge:candidate.maxAge,connectionUrl:candidate.endpoint,connectionLabel:candidate.label,usingFallback:index>0};if(publicationDelayed(row)){delayed??=row;throw new Error('Provider publication is outside its freshness window');}memory.set(key,row);
   await writeFeedCache(key,row);
   return row;
  }catch(error){lastError=error;}}
  if(delayed){memory.set(key,delayed);return delayed;}throw lastError??new Error('Source could not be reached');
 })();pending.set(key,request);}
 try{return cachedResult(await request);}finally{pending.delete(key);}
 }catch(error){const message=error instanceof Error?error.message:'Source unavailable';if(old)return {...old,state:'stale',error:message};throw new Error(message);}
}
