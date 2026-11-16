import type { Scope, Source } from './model';
import { cachedFeed } from './fetch-source';
import { parseHeadlines } from './news-parser';
const publishers:Record<Scope,Source>={
 bay:{id:'news-bay',name:'KQED',sector:'comms',mode:'automatic',format:'xml',interval:600,url:'https://www.kqed.org/news',endpoint:'https://ww2.kqed.org/news/feed/',description:'Bay Area reporting'},
 ca:{id:'news-ca',name:'CalMatters',sector:'comms',mode:'automatic',format:'xml',interval:600,url:'https://calmatters.org/',endpoint:'https://calmatters.org/feed/',description:'California reporting'},
 us:{id:'news-us',name:'PBS NewsHour',sector:'comms',mode:'automatic',format:'xml',interval:600,url:'https://www.pbs.org/newshour/',endpoint:'https://www.pbs.org/newshour/feeds/rss/headlines',fallbacks:[{endpoint:'https://feeds.npr.org/1001/rss.xml',label:'NPR'}],description:'National headlines'}
};
export async function getNews(region:Scope){const source=publishers[region],checkedAt=Date.now();try{const data=await cachedFeed(source,text=>{if(!parseHeadlines(text).length)throw new Error('Publisher has no recent dated headlines');});return {region,provider:data.connectionLabel,state:data.state,checkedAt,lastSuccess:data.fetchedAt,message:data.error??'Direct publisher feed',items:parseHeadlines(data.payload)};}catch(error){return {region,provider:source.name,state:'unavailable',checkedAt,lastSuccess:null,message:error instanceof Error&&!/internal error; reference/i.test(error.message)?error.message:'Publisher temporarily unreachable. Retry when connected.',items:[]};}}
