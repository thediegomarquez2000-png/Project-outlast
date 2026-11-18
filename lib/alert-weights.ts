import { type Incident, type Source, level } from './model';

// Severity (0-100) for National Weather Service alerts, ranked by alert type rather than the coarse
// CAP "severity" field. NWS marks many routine products (High Wind Warning, Freeze Warning,
// Winter Storm Warning) as "Severe", which put them on par with a tornado warning.
// Reference points elsewhere in the index: local M6+ earthquake 90, M5 75, M4 45; evacuation order 95.
const EVENTS: Record<string, number> = {
  // Immediate threat to life
  'Tornado Warning': 92, 'Extreme Wind Warning': 92, 'Tsunami Warning': 92, 'Storm Surge Warning': 85,
  'Hurricane Warning': 85, 'Earthquake Warning': 90, 'Evacuation Immediate': 95, 'Civil Danger Warning': 85,
  'Civil Emergency Message': 85, 'Shelter In Place Warning': 85, 'Nuclear Power Plant Warning': 85,
  'Hazardous Materials Warning': 80, 'Radiological Hazard Warning': 80, 'Fire Warning': 80, 'Law Enforcement Warning': 85,
  // Serious, often damaging
  'Flash Flood Warning': 70, 'Severe Thunderstorm Warning': 58, 'Blizzard Warning': 60, 'Ice Storm Warning': 60,
  'Typhoon Warning': 85, 'Tropical Storm Warning': 55, 'Extreme Heat Warning': 55, 'Excessive Heat Warning': 55,
  'Red Flag Warning': 45, 'Flood Warning': 45, 'Coastal Flood Warning': 40, 'Lakeshore Flood Warning': 35,
  'Dust Storm Warning': 50, 'Avalanche Warning': 50, 'Tsunami Advisory': 50, 'Debris Flow Warning': 65,
  // Disruptive but rarely dangerous to people indoors
  'High Wind Warning': 25, 'Winter Storm Warning': 35, 'Extreme Cold Warning': 40, 'Wind Chill Warning': 35,
  'Hard Freeze Warning': 22, 'Freeze Warning': 18, 'Heat Advisory': 22, 'Air Quality Alert': 25, 'Dense Smoke Advisory': 25,
  'Lake Effect Snow Warning': 35, 'High Surf Warning': 25, 'Hurricane Force Wind Warning': 30, 'Storm Warning': 25,
  // Watches: the event is possible, not occurring
  'Tornado Watch': 40, 'Hurricane Watch': 45, 'Tsunami Watch': 35, 'Flash Flood Watch': 30, 'Severe Thunderstorm Watch': 30,
  'Fire Weather Watch': 25, 'Flood Watch': 22, 'Winter Storm Watch': 18, 'High Wind Watch': 15, 'Extreme Heat Watch': 20,
  'Excessive Heat Watch': 20, 'Blizzard Watch': 22, 'Storm Surge Watch': 40, 'Tropical Storm Watch': 30, 'Gale Watch': 6,
  // Advisories and statements: nuisance-level
  'Wind Advisory': 15, 'Winter Weather Advisory': 14, 'Cold Weather Advisory': 12, 'Wind Chill Advisory': 12,
  'Frost Advisory': 6, 'Dense Fog Advisory': 12, 'Flood Advisory': 15, 'Coastal Flood Advisory': 10, 'Lake Wind Advisory': 6,
  'High Surf Advisory': 8, 'Beach Hazards Statement': 6, 'Rip Current Statement': 8, 'Small Craft Advisory': 4,
  'Gale Warning': 10, 'Special Weather Statement': 10, 'Hazardous Weather Outlook': 0, 'Short Term Forecast': 0,
  'Hydrologic Outlook': 0, 'Air Stagnation Advisory': 8, 'Blowing Dust Advisory': 15, 'Freezing Fog Advisory': 12,
};
// Unlisted products fall back to CAP severity, scaled by product class.
const CAP: Record<string, number> = { Extreme: 70, Severe: 40, Moderate: 20, Minor: 8 };
export function weatherAlertSeverity(event: string, capSeverity?: string, text = ''): number {
  if (/tornado emergency|flash flood emergency/i.test(text)) return 98;
  const known = EVENTS[event.trim()];
  if (known !== undefined) return known;
  const base = CAP[capSeverity ?? ''] ?? 15;
  return Math.round(base * (/watch/i.test(event) ? 0.6 : /advisory|statement|outlook/i.test(event) ? 0.5 : 1));
}

// ---------------------------------------------------------------------------------------------
// Index scoring policy (owner-defined, Nov 2026). Applied to every source's incidents after parsing:
//   * ordinary provider incidents ................................ 2
//   * a society-critical provider actually down (major/critical) . 25
//   * nationwide banking failure (2+ Fed payment rails disrupted) . 60 (one rail 25)
//   * power outages, by customers out and restoration estimate (v3.1, realistic tiers):
//       <10 → 4 · 10-99 → 10 · 100-999 → 25 · 1k-9.9k → 35 · 10k-99k → 60 · 100k+ → 85
//       1k+ with a 24h+ estimate → at least 60 · 10k+ with 48h+ → at least 85 · 100k+ with 48h+ → 95
//   * CAISO grid emergencies: Flex Alert/watch 20 · EEA1 35 · EEA2 50 · EEA3 (rotating outages) 75
//   * water: boil-water / do-not-drink 60 · regional emergency bulletin 35 · street-level outage 30
//   * road closures: ramp or lane 5 · planned full highway closure 15 · other transport capped at 20 (emergency highway
//     closure 30, security/outage ground stop 60, unscheduled local airport closure 70, 3+ highways cut 75)
//   * national security / civil emergency (NWS civil alerts) ..... 85
//   * natural disasters (earthquake by magnitude at the epicenter) up to 90
// These are intensities: how bad it is for the people inside the event. How far it reaches across the
// selected scope (Bay Area, California, United States) is applied afterwards in lib/exposure.ts.
// ---------------------------------------------------------------------------------------------
export const CRITICAL_PROVIDERS = new Set(['aws', 'gcloud', 'azure', 'cloudflare', 'akamai']);
// Size and expected duration: a city dark for days (canned-food territory) is far worse than an afternoon outage.
// PG&E alone usually has several 1,000+ customer outages somewhere in the Bay Area on an ordinary day, so a
// single outage of that size is an advisory, not an emergency. It becomes serious with size or duration.
export function outageScore(customers: number, restoreAt?: number, now = Date.now()) {
  const base = customers >= 100000 ? 85 : customers >= 10000 ? 60 : customers >= 1000 ? 35 : customers >= 100 ? 25 : customers >= 10 ? 10 : 4;
  if (customers < 1000) return base;
  const hours = restoreAt === undefined ? 0 : (restoreAt - now) / 3600000;
  if (customers >= 100000 && hours > 48) return 95;
  if (customers >= 10000 && hours > 48) return Math.max(base, 85);
  if (hours > 24) return Math.max(base, 60);
  return base;
}
// Intensity at the epicenter. Distance and population reach are applied by the scope lens (lib/exposure.ts),
// so a distant quake is no longer halved here.
export function earthquakeScore(magnitude: number) {
  return magnitude >= 6 ? 90 : magnitude >= 5 ? 75 : magnitude >= 4 ? 45 : magnitude >= 3 ? 15 : 5;
}
function rescore(source: Source, i: Incident): number {
  const was = i.severity;
  if (source.sector === 'comms' || source.sector === 'payments') {
    if (source.id === 'radioblackout') return was >= 35 ? 25 : 2; // R3+ blackouts disrupt HF radio and GPS
    // Federal Reserve rails move money between banks. One rail down (e.g. FedNow) is serious but contained;
    // a nationwide banking failure is handled in applyScoringPolicy (2+ rails in "Service Disruption" = 60).
    if (source.id === 'fed') return /disruption/i.test(i.status) ? 25 : 2;
    return CRITICAL_PROVIDERS.has(source.id) && was >= 55 ? 25 : 2;
  }
  if (source.sector === 'power') {
    if (i.affected !== undefined) return outageScore(i.affected, i.restoreAt);
    if (source.id === 'caiso') return was >= 92 ? 75 : was >= 75 ? 50 : was >= 58 ? 35 : 20; // EEA3 rotating outages, EEA2, EEA1, Flex Alert / watch
    if (source.id === 'geomag') return was >= 55 ? 60 : was >= 35 ? 25 : 5; // G4+ can trip grid equipment
    return was;
  }
  // Unsafe water affects everyone on the system; a main break affects one street for hours.
  if (source.sector === 'water') return was >= 80 ? 60 : was >= 40 ? 35 : was >= 35 ? 30 : Math.min(was, 15);
  // Ordinary transport disruption (weather ground stops, planned roadwork, scheduled closures, chain controls) is a
  // travel problem, not danger: capped at 20 (repeated SFO ground stops showed how quickly it otherwise dominates).
  // Exceptions are events that strand people: see strandingScore() and the area check in applyScoringPolicy().
  if (source.sector === 'transport') return Math.max(routineTransport(i, was), strandingScore(source, i));
  if (source.id === 'usgs') {
    const mag = Number(i.title.match(/^M(-?\d+(?:\.\d+)?)/)?.[1]);
    return Number.isFinite(mag) ? earthquakeScore(mag) : was;
  }
  return was;
}
const EMERGENCY_WORK = /emergency|incident|collision|crash|slide|fire|flood|hazmat|spill|debris|sinkhole|earthquake|storm damage|stalled|disabled vehicles/i;
// A full closure of the highway itself (not a ramp or lane) for an emergency rather than planned work.
export const isEmergencyHighwayClosure = (i: Incident) => /full (mainline|highway|conventional hwy) closure/i.test(i.title) && EMERGENCY_WORK.test(i.description.split('.')[0]);
// Road closures by whether traffic has a way around: a closed ramp or a lane closure leaves the highway open, and a
// planned full closure has a signed detour. Emergency full closures are handled by strandingScore() (30, or 75 for 3+).
export function routineTransport(i: Incident, was: number): number {
  if (/ closure$/i.test(i.title)) {
    if (/full (mainline|highway|conventional hwy) closure$/i.test(i.title)) return 15;
    if (/ramp|connector|lane|alternating|one-way|shoulder|surface street|rest area/i.test(i.title)) return 5;
  }
  return Math.min(was, 20);
}
export function strandingScore(source: Source, i: Incident): number {
  if (source.id === 'faa') {
    const notice = i.description;
    // Whole airport closed ("AD AP CLSD") with no daily/scheduled window and not limited to certain aircraft.
    if (/Airport Closures/i.test(i.title) && /AD AP CLSD/i.test(notice) && !/\bDLY\b|\b\d{10}-\d{10}\b|NON SKED|TRANSIENT|PPR/i.test(notice) && i.geographic === 'local') return 70;
    if (/Ground Stop/i.test(i.title) && /security|threat|evacuat|fire|emergency|equipment|outage|power|atc zero|bomb/i.test(notice)) return 60;
    return 0;
  }
  return isEmergencyHighwayClosure(i) ? 30 : 0;
}
export function applyScoringPolicy(source: Source, incidents: Incident[]): Incident[] {
  const out = incidents.map(i => { const severity = rescore(source, i); return severity === i.severity ? i : { ...i, severity, level: level(severity) }; });
  // Nationwide banking failure: two or more Fed payment rails disrupted at once means people broadly cannot move
  // money (paychecks, transfers, card settlement). Owner-defined as equal to losing power or water: 60.
  if (source.id === 'fed' && out.filter(i => /disruption/i.test(i.status)).length >= 2) out.forEach((i, k) => { if (/disruption/i.test(i.status)) out[k] = { ...i, severity: 60, level: level(60) }; });
  // Many small outages add up: score the area total too, so a storm with hundreds of small outages still registers.
  if (source.sector === 'power') {
    const total = incidents.reduce((n, i) => n + (i.affected ?? 0), 0), worst = Math.max(0, ...out.map(i => i.severity)), restore = incidents.filter(i => (i.affected ?? 0) >= 100 && i.restoreAt).map(i => i.restoreAt as number), areaScore = outageScore(total, restore.length ? Math.max(...restore) : undefined);
    if (total > 0 && areaScore > worst) out.unshift({ id: `${source.id}-area-total`, sourceId: source.id, sector: source.sector, title: `${total.toLocaleString('en-US')} ${source.name.replace(/ outages.*| local outages/i, '')} customer accounts out across the selected area`, description: `Combined total of ${incidents.length} reported outage locations. Individually small outages can add up to a widespread event.`, severity: areaScore, level: level(areaScore), place: 'Selected area', time: Math.max(...incidents.map(i => i.time)), url: source.url, status: 'Area total', geographic: 'regional', affected: undefined });
  }
  // Roads out are cut: three or more simultaneous emergency full highway closures in one area (e.g. mass stalled
  // vehicles, a slide or a disaster) can strand people, so this rises well above the ordinary transport cap.
  if (source.sector === 'transport') {
    const cut = incidents.filter(isEmergencyHighwayClosure);
    if (cut.length >= 3) out.unshift({ id: `${source.id}-roads-cut`, sourceId: source.id, sector: source.sector, title: `${cut.length} highways fully closed for emergencies`, description: `Simultaneous emergency full closures: ${cut.slice(0, 6).map(i => i.title).join('; ')}. Routes in and out of the area may be cut.`, severity: 75, level: level(75), place: 'Selected area', time: Math.max(...cut.map(i => i.time)), url: source.url, status: 'Routes cut', geographic: 'regional' });
  }
  return out;
}
