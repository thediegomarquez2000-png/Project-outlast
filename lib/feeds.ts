import { recordObservation } from './storage';
import { cachedFeed } from './fetch-source';
import { providerParsers, bayWeatherArea } from './providers';
import { weatherAlertSeverity, applyScoringPolicy } from './alert-weights';
import { withExposure } from './exposure';
import { type Scope, type Source, type SourceResult, type Incident, type DashboardData, type Snapshot, SOURCE_DEFS, summarizeSources, level } from './model';

const MINUTE=60_000;
const localCenter=[37.3382,-121.8863];
const geoUS=(lat:number,lon:number)=>(lat>=24&&lat<=50&&lon>=-125&&lon<=-66)||(lat>=50&&lat<=72&&lon>=-180&&lon<=-129)||(lat>=18&&lat<=23&&lon>=-161&&lon<=-154);
function dist(lat:number,lon:number){const r=Math.PI/180;const a=Math.sin((lat-localCenter[0])*r/2)**2+Math.cos(lat*r)*Math.cos(localCenter[0]*r)*Math.sin((lon-localCenter[1])*r/2)**2;return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));}
function inside(lat:number,lon:number,scope:Scope){return scope==='bay'?dist(lat,lon)<=145:scope==='ca'?lat>=32.5&&lat<=42&&lon>=-124.5&&lon<=-114:geoUS(lat,lon);}
const date=(x:unknown,fallback=Date.now())=>{const v=typeof x==='number'?x:Date.parse(String(x??''));return Number.isFinite(v)?v:fallback;};
const clean=(s:unknown)=>String(s??'').replace(/<script\b[\s\S]*?<\/script>/gi,'').replace(/<style\b[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/\s+/g,' ').trim();
const xml=(s:string,key:string)=>clean(s.match(new RegExp(`<${key}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${key}>`,'i'))?.[1]??'');
function safeUrl(u:unknown,fallback:string){try{const url=new URL(String(u));return url.protocol==='https:'?url.href:fallback;}catch{return fallback;}}
function incident(source:Source,values:Partial<Incident>&Pick<Incident,'id'|'title'|'severity'>):Incident{return {sourceId:source.id,sector:source.sector,description:'',place:'',time:Date.now(),url:source.url,status:'Active',geographic:'regional',level:level(values.severity),...values};}


function weather(source:Source,text:string,scope:Scope):Incident[]{
  const d=JSON.parse(text);if(!Array.isArray(d.features))throw new Error('Weather feed format changed');
  return d.features.filter((f:any)=>{
    const p=f.properties;if(!p||p.status!=='Actual'||date(p.expires,Infinity)<=Date.now())return false;
    if(scope==='us')return true;
    const codes=(p.geocode?.UGC??[]) as string[];
    if(scope==='ca')return codes.some(x=>x.startsWith('CA'));
    return bayWeatherArea(p);
  }).map((f:any)=>{
    const p=f.properties;const severity=weatherAlertSeverity(String(p.event??''),p.severity,`${p.headline??''} ${p.description??''}`);
    let lat:number|undefined,lon:number|undefined;
    if(f.geometry?.type==='Polygon'){const a=f.geometry.coordinates[0];lon=a.reduce((s:number,c:number[])=>s+c[0],0)/a.length;lat=a.reduce((s:number,c:number[])=>s+c[1],0)/a.length;}
    return incident(source,{id:p.id??f.id,title:p.event,description:clean(p.description).slice(0,5000),severity,place:p.areaDesc,time:date(p.sent),expires:date(p.expires),url:safeUrl(p.web,source.url),instruction:clean(p.instruction),status:p.urgency==='Immediate'?'Immediate':'Active alert',geographic:bayWeatherArea(p)?'local':'regional',lat,lon,areas:((p.geocode?.SAME??[]) as string[]).map(x=>String(x).slice(-5))});
  });
}
function quakes(source:Source,text:string,scope:Scope):Incident[]{const d=JSON.parse(text);if(!Array.isArray(d.features))throw new Error('USGS feed format changed');return d.features.filter((f:any)=>{const [lon,lat]=f.geometry.coordinates;return inside(lat,lon,scope);}).map((f:any)=>{const p=f.properties;const [lon,lat,depth]=f.geometry.coordinates;const mag=Number(p.mag);const severity=mag>=6?90:mag>=5?62:mag>=4?35:mag>=3?14:5;return incident(source,{id:f.id,title:`M${mag.toFixed(1)} earthquake`,description:`${p.place}. Depth ${Number(depth).toFixed(1)} km. Reported by USGS. Magnitude and location may be revised. This is a recorded event, not a forecast or an early-warning service.`,severity,place:p.place,time:date(p.time),url:safeUrl(p.url,source.url),lat,lon,geographic:dist(lat,lon)<=145?'local':'regional',status:'Recorded event'});});}
function statusPage(source:Source,text:string):Incident[]{const d=JSON.parse(text);if(!Array.isArray(d.incidents))throw new Error('Provider status format changed');return d.incidents.filter((x:any)=>!['resolved','postmortem'].includes(x.status)).map((x:any)=>{const severity=({critical:85,major:60,minor:24,none:10} as Record<string,number>)[x.impact]??20;return incident(source,{id:x.id,title:x.name,description:clean(x.incident_updates?.[0]?.body??x.status).slice(0,5000),severity,place:`${source.name} · provider-wide reporting`,time:date(x.updated_at??x.created_at),url:safeUrl(x.shortlink,source.url),status:clean(x.status).replaceAll('_',' '),geographic:'global'});});}
function pacificDate(s:string):number|null{
  const normalized=s.replace(/(\d+)(st|nd|rd|th)/gi,'$1').replace(/\s*-\s*/,' ').replace(/(\d)(am|pm)/i,'$1 $2');
  const value=Date.parse(normalized+' PST');if(!Number.isFinite(value))return null;
  const guess=new Date(value);const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(guess).map(x=>[x.type,x.value]));
  const asUTC=Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute);
  const utcNaive=value-8*3600000;return value-(asUTC-utcNaive);
}
function water(source:Source,text:string,scope:Scope):Incident[]{
  if(scope==='us'||scope==='ca'||scope==='bay'){
    const blocks=[...text.matchAll(/<div class="outage-item[^>]*>([\s\S]*?)(?=<div class="row repeater-item"|<\/section>|<div class="row">)/gi)];
    if(text.includes('repeater-header')&&blocks.length===0)throw new Error('Water notice format changed');
    return blocks.flatMap((m,i)=>{const block=m[1];const title=clean(block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1]);const values:Record<string,string>={};for(const p of block.matchAll(/<p>\s*<strong>([^<]+)<\/strong>([\s\S]*?)<\/p>/gi))values[clean(p[1]).replace(/:$/,'')]=clean(p[2]);
      const start=pacificDate(values['Start Date']??''),end=pacificDate(values['End Date']??'');if(start===null||end===null)return [];if(end<Date.now()||start>Date.now()+24*3600000)return [];
      const planned=start>Date.now();return [incident(source,{id:`sjw-${title}-${start}-${i}`,title:`${planned?'Scheduled: ':''}${values['Service Impact']??'Service notice'} · ${values.Location??title}`,description:`${values['Nature of Work']??title}. Published window: ${values['Start Date']} to ${values['End Date']} Pacific. This street-level notice does not establish an interruption at your address.`,severity:planned?12:/Total Outage/i.test(values['Service Impact']??'')?35:18,place:`${values.Location??title} · San Jose Water service area`,time:start,expires:end,status:planned?'Scheduled notice':'Service notice',geographic:'local',url:source.url})];});
  }return [];
}
const AIRPORTS:Record<string,[number,number,string,string]>={SFO:[37.6213,-122.379,'San Francisco','CA'],SJC:[37.3639,-121.9289,'San Jose','CA'],OAK:[37.7213,-122.221,'Oakland','CA'],LAX:[33.9416,-118.4085,'Los Angeles','CA'],SAN:[32.7338,-117.1933,'San Diego','CA'],SNA:[33.6757,-117.8682,'Orange County','CA'],SMF:[38.6954,-121.5908,'Sacramento','CA'],BUR:[34.2007,-118.3587,'Burbank','CA'],ONT:[34.056,-117.601,'Ontario','CA'],LGA:[40.7769,-73.874,'New York LaGuardia','NY'],JFK:[40.6413,-73.7781,'New York JFK','NY'],EWR:[40.6895,-74.1745,'Newark','NJ'],ORD:[41.9742,-87.9073,'Chicago','IL'],ATL:[33.6407,-84.4277,'Atlanta','GA'],DFW:[32.8998,-97.0403,'Dallas Fort Worth','TX'],AUS:[30.1975,-97.6664,'Austin','TX'],DEN:[39.8561,-104.6737,'Denver','CO'],LAS:[36.084,-115.1537,'Las Vegas','NV'],SEA:[47.4502,-122.3088,'Seattle','WA'],PHX:[33.4342,-112.0116,'Phoenix','AZ'],BOS:[42.3656,-71.0096,'Boston','MA'],MIA:[25.7959,-80.287,'Miami','FL'],IAD:[38.9531,-77.4565,'Washington Dulles','VA'],DCA:[38.8512,-77.0402,'Washington National','VA'],PHL:[39.8744,-75.2424,'Philadelphia','PA']};
function aviation(source:Source,text:string,scope:Scope):Incident[]{let records:Incident[]=[];const updated=date(xml(text,'Update_Time'));
  for(const part of text.matchAll(/<Delay_type>([\s\S]*?)<\/Delay_type>/g)){const name=xml(part[1],'Name');let blocks=[...part[1].matchAll(/<(Program|Ground_Delay|Airport|Delay)>([\s\S]*?)<\/\1>/g)];
    for(const [, , b] of blocks){const code=xml(b,'ARPT');if(!code)continue;const a=AIRPORTS[code];if(scope==='bay'&&!['SFO','SJC','OAK'].includes(code))continue;if(scope==='ca'&&a?.[3]!=='CA')continue;
      const reason=xml(b,'Reason');const limited=/NON SKED|GENERAL AVIATION|TRANSIENT|PPR/i.test(reason);const closed=/Closures/i.test(name);const severity=closed?(limited?12:65):/Ground Stop/.test(name)?55:25;
      records.push(incident(source,{id:`faa-${code}-${name}-${reason.slice(0,50)}`,title:`${code} · ${closed&&limited?'Aircraft-specific restriction':name.replace(/ Programs$/,'')}`,description:`${reason}. ${xml(b,'Avg')?'Average delay: '+xml(b,'Avg')+'. ':''}${xml(b,'Max')?'Maximum reported: '+xml(b,'Max')+'. ':''}${xml(b,'End_Time')?'Reported end: '+xml(b,'End_Time')+'. ':''}${limited?'This notice applies to specified aircraft; it does not mean all commercial flights are stopped. ':''}Check your airline for your individual flight.`,severity,place:a?`${a[2]} · ${code}`:code,lat:a?.[0],lon:a?.[1],time:updated,status:'FAA notice',geographic:['SFO','SJC','OAK'].includes(code)?'local':'regional',url:source.url}));
    }
  }return records;
}
function grid(source:Source,text:string):Incident[]{const d=JSON.parse(text);if(!Array.isArray(d.CurrentEvents))throw new Error('Grid notice format changed');return d.CurrentEvents.map((x:any)=>{const label=clean(x.EventType??'Grid notification');const score=/EEA\s*3|Emergency\s*3/i.test(label)?92:/EEA\s*2|Emergency\s*2/i.test(label)?75:/EEA\s*1|Emergency\s*1/i.test(label)?58:/Watch|Flex/i.test(label)?32:22;return incident(source,{id:String(x.EventId??label),title:label,description:clean(JSON.stringify(x.EventMessages??[])).slice(0,4000),severity:score,place:'California ISO balancing area',time:Date.now(),status:x.InEffect?'In effect':'Published event',geographic:'regional',url:source.url});});}
function federal(source:Source,text:string):Incident[]{const rows=[...text.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].filter(m=>/FedACH|FedNow|Fedwire Funds|Fedwire Securities/.test(clean(m[1])));if(rows.length<3)throw new Error('Federal Reserve status layout changed');return rows.flatMap(m=>{const name=clean(m[1]).replace(/\s+/g,' ').trim();const status=m[1].match(/alt="([^"]+)"/i)?.[1];if(!status||!/Normal Operations|Service Issue|Service Disruption/i.test(status))throw new Error('Federal Reserve status could not be verified');if(/Normal Operations/i.test(status))return [];return [incident(source,{id:`fed-${name}`,title:`${name} · ${status}`,description:`The Federal Reserve reports ${status.toLowerCase()} for ${name}. Consult the official service message for operational details. Consumer bank and card status must be checked separately.`,severity:/Disruption/i.test(status)?70:35,place:'U.S. payment services',time:Date.now(),status,geographic:'national',url:source.url})];});}
async function readSource(source:Source,scope:Scope):Promise<SourceResult>{
 const checkedAt=Date.now();try{
 const parser=({...providerParsers,nws:weather,usgs:quakes,cloudflare:statusPage,github:statusPage,banks:statusPage,sjwater:water,faa:aviation,caiso:grid,fed:federal} as Record<string,(s:Source,p:string,g:Scope)=>Incident[]>)[source.id];
 if(!parser)throw new Error('No validated adapter is configured');
 const validate=(payload:string)=>{if(source.id==='faa'&&!payload.includes('<AIRPORT_STATUS_INFORMATION'))throw new Error('Unexpected FAA format');if(source.id==='sjwater'&&!payload.includes('Outage Information'))throw new Error('Water page format changed');return parser(source,payload,'us');};
 const result=await cachedFeed(source,validate);const incidents=applyScoringPolicy(source,parser(source,result.payload,scope)).map(i=>withExposure(source,i));
 const customers=incidents.reduce((sum,i)=>sum+(i.affected??0),0);
 const detail=source.id==='pge'?`${incidents.filter(i=>i.affected!==undefined).length} outage locations · ${customers.toLocaleString('en-US')} customer accounts`:`${incidents.length} relevant published records`;
 return {...source,state:result.state,checkedAt,lastSuccess:result.fetchedAt,publishedAt:result.publishedAt,connectionUrl:result.connectionUrl,connectionLabel:result.connectionLabel,usingFallback:result.usingFallback,message:result.state==='fresh'?`${result.connectionLabel} · ${detail}`:result.publishedAt&&result.maxPublicationAge&&Date.now()-result.publishedAt>result.maxPublicationAge*1000?'Provider publication delayed. Dated records are available in the source panel and excluded from the current index.':`Refresh failed; last successful response retained. ${result.error??''}`,incidents};
 }catch(error){return {...source,state:'unavailable',checkedAt,lastSuccess:null,message:error instanceof Error&&!/internal error; reference/i.test(error.message)?error.message:'Provider could not be reached. Retrying on the next check.',incidents:[]};}
}

export async function getDashboard(scope:Scope):Promise<DashboardData>{
  const sources=await Promise.all(SOURCE_DEFS.map(s=>readSource(s,scope)));
  const {incidents,sectors,score,coverage,peak,confidence}=summarizeSources(sources,scope);
  const generatedAt=Date.now();const bucket=Math.floor(generatedAt/(5*MINUTE))*5*MINUTE;const sectorScores=Object.fromEntries(sectors.map(s=>[s.id,s.score]));
  const {history,historyPersistent}=await recordObservation(scope,{time:bucket,score,coverage,sectors:sectorScores});
  return {scope,generatedAt,nextRefresh:generatedAt+180_000,score,coverage,peak,confidence,sectors,sources,incidents,history,historyPersistent,critical:incidents.some(x=>x.severity>=85&&x.geographic==='local')};
}
