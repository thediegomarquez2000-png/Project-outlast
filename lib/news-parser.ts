import { cleanText } from './providers';
export interface Headline {id:string;title:string;url:string;publishedAt:number}
export function parseHeadlines(text:string,now=Date.now()):Headline[]{
 if(!/<rss\b|<feed\b/i.test(text))throw new Error('Publisher feed format changed');
 const items=[...text.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
 if(!items.length)throw new Error('Publisher returned no headline records');
 const get=(s:string,k:string)=>s.match(new RegExp(`<${k}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${k}>`,'i'))?.[1]??'';
 const seen=new Set<string>();return items.flatMap(([, ,b])=>{const title=cleanText(get(b,'title'));const raw=cleanText(get(b,'link'))||b.match(/<link\b[^>]*href="([^"]+)"/)?.[1];let url:URL;try{url=new URL(raw??'');if(url.protocol!=='https:')return [];}catch{return [];}
 const publishedAt=Date.parse(cleanText(get(b,'pubDate')||get(b,'published')||get(b,'updated')));if(!title||!Number.isFinite(publishedAt)||publishedAt>now+300000||now-publishedAt>7*86400000||seen.has(url.href))return [];seen.add(url.href);return [{id:url.href,title,url:url.href,publishedAt}];}).sort((a,b)=>b.publishedAt-a.publishedAt).slice(0,8);
}
