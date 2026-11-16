export const runtime='nodejs';
export const maxDuration=60;
import { getNews } from '../../../lib/news';
export async function GET(request:Request){const value=new URL(request.url).searchParams.get('region');const region=value==='ca'||value==='us'?value:'bay';return Response.json(await getNews(region),{headers:{'Cache-Control':'public, max-age=0, must-revalidate','Vercel-CDN-Cache-Control':'public, s-maxage=600, stale-while-revalidate=30'}});}
