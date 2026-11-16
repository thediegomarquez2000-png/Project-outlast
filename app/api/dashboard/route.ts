export const runtime='nodejs';
export const maxDuration=60;
import { getDashboard } from '../../../lib/feeds';
import type { Scope } from '../../../lib/model';
export const dynamic='force-dynamic';
export async function GET(request:Request){const raw=new URL(request.url).searchParams.get('scope');const scope:Scope=raw==='ca'||raw==='us'?raw:'bay';try{return Response.json(await getDashboard(scope),{headers:{'Cache-Control':'public, max-age=0, must-revalidate','Vercel-CDN-Cache-Control':'public, s-maxage=180, stale-while-revalidate=30'}});}catch{return Response.json({error:'Unable to assemble the monitoring snapshot. Please retry.'},{status:503});}}
