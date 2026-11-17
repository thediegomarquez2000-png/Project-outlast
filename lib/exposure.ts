// ---------------------------------------------------------------------------------------------
// OUTLAST scoring v3 — one severity ladder, three lenses.
//
// Every incident carries two numbers:
//   severity (0-100) . how bad it is for the people inside it (owner ladder in alert-weights.ts)
//   people ........... how many people it touches (utility-reported, census-derived, or estimated)
//
// Each scope then answers a different question with the same incidents:
//   LOCAL  (Bay Area, 145 km of San Jose) — "How hard is life hit near me?"
//          Intensity lens: severity, discounted gently with distance (full within 40 km, 0.6 at 145 km).
//   STATE  (California)                   — "How much of California is disrupted, and how badly?"
//   NATION (United States)                — "How much of the country is disrupted, and how badly?"
//          Breadth lens: severity × reach, where reach is the share of the scope's population affected
//          at that severity or worse, on a log scale (0.025% → 0, 0.25% → ⅓, 2.5% → ⅔, 25%+ → 1).
//          A tornado warning over one county stops reading like a national emergency; a nationwide
//          payment-rail failure (systemic, reach 1) still reads 60 everywhere.
//
// Populations: U.S. Census county estimates (2019 vintage, via the JHU CSSE FIPS lookup table).
// ---------------------------------------------------------------------------------------------
import type { Incident, Scope, SectorId, Source } from './model';
import counties from './county-population.json';

type County = [population: number, lat: number, lon: number];
const COUNTY = counties as unknown as Record<string, County>;
const HOME: [number, number] = [37.3382, -121.8863];
export const LOCAL_RADIUS_KM = 145;

export function km(lat1: number, lon1: number, lat2 = HOME[0], lon2 = HOME[1]) {
  const r = Math.PI / 180, a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
const all = Object.entries(COUNTY);
export const POPULATION: Record<Scope, number> = {
  bay: all.filter(([, c]) => km(c[1], c[2]) <= LOCAL_RADIUS_KM).reduce((n, [, c]) => n + c[0], 0),
  ca: all.filter(([f]) => f.startsWith('06')).reduce((n, [, c]) => n + c[0], 0),
  us: all.reduce((n, [, c]) => n + c[0], 0),
};
export const countyPopulation = (fips: string) => COUNTY[fips]?.[0] ?? 0;

// ---- Reach and proximity --------------------------------------------------------------------------
/** Share of the scope's population affected → 0..1 on a log scale. 0.025% → 0, 0.25% → ⅓, 2.5% → ⅔, 25% → 1. */
export function reach(share: number) {
  if (!(share > 0)) return 0;
  return Math.max(0, Math.min(1, Math.log10(share / 0.00025) / 3));
}
/** Life-threatening events (85+) never vanish from a wide view: they keep at least this much reach. */
const LIFE_SAFETY_FLOOR: Record<Scope, number> = { bay: 1, ca: 0.3, us: 0.15 };
/** Local lens: full weight within 40 km of home, tapering to 0.6 at the edge of the 145 km area. */
export function proximity(i: Incident) {
  if (i.geographic === 'national' || i.geographic === 'global') return 1;
  if (i.lat === undefined || i.lon === undefined) return 1;
  const d = Math.max(0, km(i.lat, i.lon) - (i.radiusKm ?? 0)); // distance to the event's footprint, not its center
  return d <= 40 ? 1 : d >= LOCAL_RADIUS_KM ? 0.6 : 1 - 0.4 * (d - 40) / (LOCAL_RADIUS_KM - 40);
}

// ---- People affected ---------------------------------------------------------------------------
export type PeopleBasis = 'reported' | 'census' | 'estimate' | 'systemic';
const PEOPLE_PER_ACCOUNT = 2.5; // utility "customers" are accounts (homes and businesses), not people
// Sources whose incidents affect the whole country at once (cloud, payment rails, space weather).
const SYSTEMIC = new Set<SectorId>(['comms', 'payments']);
/** Strong-shaking radius (≈ MMI VI) by magnitude: M4 ≈ 10 km, M5 ≈ 25 km, M6 ≈ 63 km, M7 ≈ 160 km. */
export const shakingRadiusKm = (mag: number) => 10 ** (0.4 * mag - 0.6);
/** People within a radius, from county centroids; small radii fall back to a share of the nearest county. */
export function peopleWithin(lat: number, lon: number, radiusKm: number) {
  let inside = 0, nearest = 0, best = Infinity;
  for (const [, c] of all) { const d = km(lat, lon, c[1], c[2]); if (d <= radiusKm) inside += c[0]; if (d < best) { best = d; nearest = c[0]; } }
  return Math.round(Math.max(inside, nearest * Math.min(1, Math.PI * radiusKm ** 2 / 3000)));
}
const fireAcres = (i: Incident) => Number(i.description.match(/([\d,]+(?:\.\d+)?) acres/)?.[1]?.replace(/,/g, ''));
const firePeople = (acres: number) => !Number.isFinite(acres) ? 5000 : acres < 1000 ? 3000 : acres < 10000 ? 15000 : acres < 100000 ? 50000 : 150000;

export function estimatePeople(source: Source, i: Incident): { people: number; basis: PeopleBasis; areas?: string[]; radiusKm?: number } {
  if (SYSTEMIC.has(source.sector) || source.id === 'geomag' || i.geographic === 'national' || i.geographic === 'global') return { people: POPULATION.us, basis: 'systemic' };
  if (i.affected !== undefined) return { people: Math.round(i.affected * PEOPLE_PER_ACCOUNT), basis: 'reported' };
  if (i.status === 'Area total') { const n = Number(i.title.match(/^([\d,]+)/)?.[1]?.replace(/,/g, '')); if (Number.isFinite(n)) return { people: Math.round(n * PEOPLE_PER_ACCOUNT), basis: 'reported' }; }
  if (i.areas?.length) { const areas = [...new Set(i.areas)].filter(f => COUNTY[f]); return { people: areas.reduce((n, f) => n + countyPopulation(f), 0), basis: 'census', areas }; }
  if (source.id === 'nws') return { people: 0, basis: 'census' }; // marine / offshore zones only
  if (source.id === 'usgs') {
    const mag = Number(i.title.match(/^M(-?\d+(?:\.\d+)?)/)?.[1]);
    if (Number.isFinite(mag) && i.lat !== undefined && i.lon !== undefined) return { people: peopleWithin(i.lat, i.lon, shakingRadiusKm(mag)), basis: 'census', radiusKm: Math.round(shakingRadiusKm(mag)) };
  }
  if (source.id === 'caiso') return { people: Math.round(POPULATION.ca * 0.8), basis: 'estimate' }; // CAISO serves ~80% of California load
  const fixed: Record<string, number> = {
    nifc: firePeople(fireAcres(i)), calfire: firePeople(fireAcres(i)), inciweb: 5000,
    alertscc: 2500, tsunami: 500000, volcano: 10000, gdacs: /red/i.test(i.status) ? 1000000 : /orange/i.test(i.status) ? 250000 : 25000,
    sjwater: 1000, sjwmap: 1000, waterquality: /boil|do not drink|unsafe/i.test(i.description) ? 20000 : 5000,
    faa: 75000, bart: /emergency/i.test(i.title) ? 400000 : 100000,
  };
  if (i.status === 'Routes cut') return { people: 200000, basis: 'estimate' };
  if (fixed[source.id] !== undefined) return { people: fixed[source.id], basis: 'estimate' };
  if (source.sector === 'transport') return { people: source.id.startsWith('cc-') ? 5000 : 20000, basis: 'estimate' };
  return { people: 10000, basis: 'estimate' };
}
export function withExposure(source: Source, i: Incident): Incident {
  const e = estimatePeople(source, i);
  return { ...i, people: e.people, peopleBasis: e.basis, ...(e.areas ? { areas: e.areas } : {}), ...(e.radiusKm ? { radiusKm: e.radiusKm } : {}) };
}

// ---- Sector score per scope -------------------------------------------------------------------
export interface SectorReading { score: number; driver: Incident | null; people: number }
/**
 * LOCAL: worst incident's severity × proximity.
 * STATE / NATION: walk incidents from most to least severe, accumulating people affected at that severity or
 * worse (NWS county lists are de-duplicated), and keep the highest severity × reach. One severe event that
 * touches few people and many mild events that touch everyone are both represented, without double counting.
 */
export function sectorReading(incidents: Incident[], scope: Scope): SectorReading {
  if (!incidents.length) return { score: 0, driver: null, people: 0 };
  const sorted = [...incidents].sort((a, b) => b.severity - a.severity);
  if (scope === 'bay') {
    let best = 0, driver: Incident | null = null;
    // Area totals ("many small outages add up") are read by breadth even locally: 6,000 scattered customers out
    // across an 11-million-person area is not the same as 6,000 out on your street.
    for (const i of sorted) { const s = i.status === 'Area total' ? i.severity * reach(Math.min(1, (i.people ?? 0) / POPULATION.bay)) : i.severity * proximity(i); if (s > best) { best = s; driver = i; } }
    return { score: Math.round(Math.min(100, best)), driver, people: sorted.reduce((n, i) => n + (i.people ?? 0), 0) };
  }
  const P = POPULATION[scope], seen = new Set<string>();
  let people = 0, best = 0, driver: Incident | null = null;
  for (const i of sorted) {
    if (i.peopleBasis === 'systemic' || (i.people === undefined && (i.geographic === 'national' || i.geographic === 'global'))) people = Math.max(people, P);
    else if (i.areas?.length) for (const f of i.areas) { if (!seen.has(f)) { seen.add(f); people += countyPopulation(f); } }
    else people += i.people ?? 0;
    const r = Math.max(reach(Math.min(1, people / P)), i.severity >= 85 ? LIFE_SAFETY_FLOOR[scope] : 0);
    const s = Math.max(0, Math.min(100, i.severity)) * r;
    if (s > best) { best = s; driver = i; }
  }
  return { score: Math.round(best), driver, people: Math.min(people, P) };
}

// ---- Visibility: how much of the scope's population each sector can actually see ------------------
// National feeds see everyone. Regional feeds see their footprint. Grid-wide signals (CAISO, geomagnetic)
// are not outage visibility and are excluded. Sources sharing a footprint count once.
const FOOTPRINT: Record<string, { group: string; bay: number; ca: number; us: number }> = {
  pge: { group: 'pge', bay: 0.85, ca: 0.405, us: 0.049 }, sce: { group: 'sce', bay: 0, ca: 0.38, us: 0.046 },
  sdge: { group: 'sdge', bay: 0, ca: 0.094, us: 0.011 }, smud: { group: 'smud', bay: 0.13, ca: 0.038, us: 0.0046 },
  sjwater: { group: 'sjw', bay: 0.09, ca: 0.025, us: 0.003 }, sjwmap: { group: 'sjw', bay: 0.09, ca: 0.025, us: 0.003 },
  waterquality: { group: 'calam', bay: 0.03, ca: 0.015, us: 0.002 },
  calfire: { group: 'ca-hazards', bay: 1, ca: 1, us: 0.12 }, alertscc: { group: 'ca-hazards', bay: 1, ca: 1, us: 0.12 },
  caltrans: { group: 'bay-transport', bay: 0.75, ca: 0.2, us: 0.025 }, bart: { group: 'bay-transport', bay: 0.75, ca: 0.2, us: 0.025 },
  'lcs-d3': { group: 'lcs-d3', bay: 0.1, ca: 0.06, us: 0.007 }, 'lcs-d5': { group: 'lcs-d5', bay: 0.06, ca: 0.02, us: 0.002 },
  'lcs-d10': { group: 'lcs-d10', bay: 0.1, ca: 0.04, us: 0.005 },
};
for (const d of ['cc-d2', 'cc-d3', 'cc-d6', 'cc-d8', 'cc-d9', 'cc-d10']) FOOTPRINT[d] = { group: 'chain-controls', bay: 0, ca: 0.05, us: 0.006 };
const SIGNAL_ONLY = new Set(['caiso', 'geomag']);
export function visibility(sources: { id: string; state: string }[], scope: Scope) {
  const groups = new Map<string, number>();
  for (const s of sources) {
    if (s.state !== 'fresh' || SIGNAL_ONLY.has(s.id)) continue;
    const f = FOOTPRINT[s.id];
    const key = f?.group ?? 'national', v = f ? f[scope] : 1;
    groups.set(key, Math.max(groups.get(key) ?? 0, v));
  }
  return Math.min(1, [...groups.values()].reduce((n, v) => n + v, 0));
}
