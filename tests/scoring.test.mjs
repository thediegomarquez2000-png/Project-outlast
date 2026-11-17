import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const temporary=await mkdtemp(join(tmpdir(),'outlast-scoring-'));
await build({entryPoints:['lib/model.ts','lib/exposure.ts','lib/alert-weights.ts'],bundle:true,format:'esm',platform:'node',outdir:temporary});
const {summarizeSources}=await import(pathToFileURL(join(temporary,'model.js')));
const X=await import(pathToFileURL(join(temporary,'exposure.js')));
after(()=>rm(temporary,{recursive:true,force:true}));

const source=(id,sector,state,incidents=[])=>({id,sector,state,incidents,mode:state==='manual'?'manual':'automatic',checkedAt:null,lastSuccess:null,name:id,url:'https://example.com',description:'fixture',message:''});
const event=(id,sourceId,sector,severity,extra={})=>({id,sourceId,sector,severity,time:1,title:id,description:'',place:'',url:'https://example.com',level:'advisory',status:'Active',geographic:'local',...extra});

// ---- Existing behaviour (local lens) --------------------------------------------------------------
test('missing feeds remain unknown, not healthy',()=>{const d=summarizeSources([source('power','power','unavailable'),source('bank','payments','manual')]);assert.equal(d.score,null);assert.equal(d.coverage,0);assert.equal(d.sectors.find(s=>s.id==='power').score,null);assert.equal(d.sectors.find(s=>s.id==='payments').score,null);});
test('stale cached incidents cannot contribute to a current score',()=>{const d=summarizeSources([source('stale','hazards','stale',[event('bad','stale','hazards',100)]),source('fresh','comms','fresh')]);assert.equal(d.score,0);assert.equal(d.incidents.length,0);assert.equal(d.sectors.find(s=>s.id==='hazards').score,null);assert.equal(d.coverage,50);});
test('related incidents use maximum sector severity and do not accumulate',()=>{const e=event('one','weather','hazards',60);const d=summarizeSources([source('weather','hazards','fresh',[e,{...e},event('two','weather','hazards',40)])]);assert.equal(d.score,60);assert.equal(d.incidents.length,2);});
test('observed weights are normalized while manual gaps stay explicit',()=>{const d=summarizeSources([source('h','hazards','fresh',[event('one','h','hazards',60)]),source('c','comms','fresh'),source('evac','hazards','manual')]);assert.equal(d.score,60);assert.equal(d.coverage,67);assert.equal(d.sectors.find(s=>s.id==='hazards').partial,true);assert.equal(d.sectors.find(s=>s.id==='water').score,null);});
test('index follows the worst system and compound failures push toward 100',()=>{const quake=source('q','hazards','fresh',[event('eq','q','hazards',90)]);const power=source('p','power','fresh',[event('o','p','power',60)]);const water=source('w','water','fresh',[event('x','w','water',60)]);const minor=source('c','comms','fresh',[event('m','c','comms',2)]);assert.equal(summarizeSources([quake,minor]).score,90);assert.equal(summarizeSources([quake,power,water,minor]).score,100);assert.equal(summarizeSources([source('h','hazards','fresh',[event('w','h','hazards',35)]),source('t','transport','fresh',[event('g','t','transport',20)])]).score,35);});

// ---- Reach curve and populations ------------------------------------------------------------------
test('reach is a log scale anchored at 0.025%, 0.25%, 2.5% and 25% of the population',()=>{assert.equal(X.reach(0.00025),0);assert.ok(Math.abs(X.reach(0.0025)-1/3)<1e-9);assert.ok(Math.abs(X.reach(0.025)-2/3)<1e-9);assert.equal(X.reach(0.25),1);assert.equal(X.reach(0.9),1);assert.equal(X.reach(0),0);});
test('scope populations come from census county data',()=>{assert.ok(X.POPULATION.ca>39e6&&X.POPULATION.ca<40e6);assert.ok(X.POPULATION.us>320e6&&X.POPULATION.us<340e6);assert.ok(X.POPULATION.bay>8e6&&X.POPULATION.bay<X.POPULATION.ca);});

// ---- Local lens: proximity -------------------------------------------------------------------------
test('local lens keeps full severity near home and tapers to 60% at the edge',()=>{const near=event('n','h','hazards',90,{lat:37.34,lon:-121.89});const edge=event('e','h','hazards',90,{lat:38.6,lon:-121.89});assert.equal(X.sectorReading([near],'bay').score,90);const s=X.sectorReading([edge],'bay').score;assert.ok(s>=54&&s<=60,`edge ${s}`);});

// ---- State and national lens: breadth ------------------------------------------------------------
const nws=(id,severity,areas)=>event(id,'nws','hazards',severity,{areas,people:areas.reduce((n,f)=>n+X.countyPopulation(f),0),peopleBasis:'census',geographic:'regional'});
test('one tornado warning over a single county does not read as a national emergency',()=>{const tornado=nws('t',92,['40027']);const us=X.sectorReading([tornado],'us').score;assert.ok(us<=20,`national ${us}`);assert.equal(X.sectorReading([tornado],'bay').score,92);});
test('a major Los Angeles earthquake is severe for California and elevated nationally',()=>{const people=X.peopleWithin(34.05,-118.25,X.shakingRadiusKm(7));const quake=event('la','usgs','hazards',90,{lat:34.05,lon:-118.25,people,peopleBasis:'census',geographic:'regional'});const ca=X.sectorReading([quake],'ca').score,us=X.sectorReading([quake],'us').score;assert.ok(ca>=75,`ca ${ca}`);assert.ok(us>=45&&us<ca,`us ${us}`);});
test('systemic failures (nationwide payment rails) read the same in every scope',()=>{const fed=event('fed','fed','payments',60,{geographic:'national',people:X.POPULATION.us,peopleBasis:'systemic'});for(const scope of ['bay','ca','us'])assert.equal(X.sectorReading([fed],scope).score,60,scope);});
test('many small outages add up statewide, and overlapping county alerts are not double counted',()=>{const outages=Array.from({length:200},(_,k)=>event('o'+k,'pge','power',30,{affected:2000,people:5000,peopleBasis:'reported',geographic:'regional'}));const one=X.sectorReading(outages.slice(0,1),'ca').score,all=X.sectorReading(outages,'ca').score;assert.ok(all>one,`${one} → ${all}`);const a=nws('a',45,['06085','06001']),b=nws('b',45,['06085','06001']);assert.equal(X.sectorReading([a,b],'ca').score,X.sectorReading([a],'ca').score);});
test('life-threatening events keep a floor so they never vanish from wide views',()=>{const evac=event('ev','alertscc','hazards',95,{people:2500,peopleBasis:'estimate',geographic:'regional'});assert.ok(X.sectorReading([evac],'ca').score>=28);assert.ok(X.sectorReading([evac],'us').score>=14);});
test('summary reports peak event, per-sector visibility and confidence',()=>{const tornado=nws('t',92,['40027']);const d=summarizeSources([source('nws','hazards','fresh',[tornado]),source('pge','power','fresh'),source('sjwater','water','fresh')],'us');assert.equal(d.peak,92);assert.ok(d.score<=20);assert.equal(d.sectors.find(s=>s.id==='hazards').visibility,1);assert.ok(d.sectors.find(s=>s.id==='power').visibility<0.1);assert.ok(d.confidence<100);const local=summarizeSources([source('pge','power','fresh')],'bay');assert.ok(local.sectors.find(s=>s.id==='power').visibility>=0.85);});
test('an empty outage feed does not invent a zero-customer area total',async()=>{const {applyScoringPolicy}=await import(pathToFileURL(join(temporary,'alert-weights.js')));assert.equal(applyScoringPolicy({id:'sce',name:'SCE outages',sector:'power',url:'https://x'},[]).length,0);});
test('locally, scattered small outages are read by breadth, not as one big outage',()=>{const total=event('t','pge','power',60,{status:'Area total',people:15000,geographic:'regional'});const s=X.sectorReading([total],'bay').score;assert.ok(s<20,`area total ${s}`);});
test('an earthquake whose shaking reaches home is not discounted for distance to its epicenter',()=>{const hayward=event('h','usgs','hazards',90,{lat:37.8,lon:-122.2,radiusKm:158,geographic:'local'});assert.equal(X.sectorReading([hayward],'bay').score,90);});
