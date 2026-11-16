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
  'High Wind Warning': 35, 'Winter Storm Warning': 35, 'Extreme Cold Warning': 40, 'Wind Chill Warning': 35,
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
//   * power or water service affected ............................ 60 (smaller outages scale down;
//     100k+ customers or a 48h+ restoration estimate 85, both 95)
//   * ordinary transport disruption .............................. capped at 20 (emergency highway
//     closure 30, security/outage ground stop 60, unscheduled local airport closure 70, 3+ highways cut 75)
//   * national security / civil emergency (NWS civil alerts) ..... 85
//   * natural disasters in your area (earthquake by magnitude) ... up to 90
// ---------------------------------------------------------------------------------------------
export const CRITICAL_PROVIDERS = new Set(['aws', 'gcloud', 'azure', 'cloudflare', 'akamai', 'fed']);
// Size and expected duration: a city dark for days (canned-food territory) is far worse than an afternoon outage.
export function outageScore(customers: number, restoreAt?: number, now = Date.now()) {
  const base = customers >= 1000 ? 60 : customers >= 100 ? 30 : customers >= 10 ? 10 : 4;
  if (customers < 1000) return base;
  const huge = customers >= 100000, long = restoreAt !== undefined && restoreAt - now > 48 * 3600000;
  return huge && long ? 95 : huge || long ? 85 : base;
}
export function earthquakeScore(magnitude: number, local: boolean) {
  const s = magnitude >= 6 ? 90 : magnitude >= 5 ? 75 : magnitude >= 4 ? 45 : magnitude >= 3 ? 15 : 5;
  return local ? s : Math.round(s / 2);
}
function rescore(source: Source, i: Incident): number {
  const was = i.severity;
  if (source.sector === 'comms' || source.sector === 'payments') {
    if (source.id === 'radioblackout') return was >= 35 ? 25 : 2; // R3+ blackouts disrupt HF radio and GPS
    return CRITICAL_PROVIDERS.has(source.id) && was >= 55 ? 25 : 2;
  }
  if (source.sector === 'power') {
    if (i.affected !== undefined) return outageScore(i.affected, i.restoreAt);
    if (source.id === 'caiso') return was >= 58 ? 60 : 20; // grid emergencies (EEA) vs. Flex Alerts / watches
    if (source.id === 'geomag') return was >= 55 ? 60 : was >= 35 ? 25 : 5; // G4+ can trip grid equipment
    return was;
  }
  if (source.sector === 'water') return was >= 35 ? 60 : Math.min(was, 15); // unplanned outage / boil-water vs. routine work
  // Ordinary transport disruption (weather ground stops, planned roadwork, scheduled closures, chain controls) is a
  // travel problem, not danger: capped at 20 (repeated SFO ground stops showed how quickly it otherwise dominates).
  // Exceptions are events that strand people: see strandingScore() and the area check in applyScoringPolicy().
  if (source.sector === 'transport') return Math.max(Math.min(was, 20), strandingScore(source, i));
  if (source.id === 'usgs') {
    const mag = Number(i.title.match(/^M(-?\d+(?:\.\d+)?)/)?.[1]);
    return Number.isFinite(mag) ? earthquakeScore(mag, i.geographic === 'local') : was;
  }
  return was;
}
const EMERGENCY_WORK = /emergency|incident|collision|crash|slide|fire|flood|hazmat|spill|debris|sinkhole|earthquake|storm damage|stalled|disabled vehicles/i;
// A full closure of the highway itself (not a ramp or lane) for an emergency rather than planned work.
export const isEmergencyHighwayClosure = (i: Incident) => /full (mainline|highway|conventional hwy) closure/i.test(i.title) && EMERGENCY_WORK.test(i.description.split('.')[0]);
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
  // Many small outages add up: score the area total too, so a storm with hundreds of small outages still registers.
  if (source.sector === 'power') {
    const total = incidents.reduce((n, i) => n + (i.affected ?? 0), 0), worst = Math.max(0, ...out.map(i => i.severity)), restore = incidents.filter(i => (i.affected ?? 0) >= 100 && i.restoreAt).map(i => i.restoreAt as number), areaScore = outageScore(total, restore.length ? Math.max(...restore) : undefined);
    if (areaScore > worst) out.unshift({ id: `${source.id}-area-total`, sourceId: source.id, sector: source.sector, title: `${total.toLocaleString('en-US')} ${source.name.replace(/ outages.*| local outages/i, '')} customer accounts out across the selected area`, description: `Combined total of ${incidents.length} reported outage locations. Individually small outages can add up to a widespread event.`, severity: areaScore, level: level(areaScore), place: 'Selected area', time: Math.max(...incidents.map(i => i.time)), url: source.url, status: 'Area total', geographic: 'regional', affected: undefined });
  }
  // Roads out are cut: three or more simultaneous emergency full highway closures in one area (e.g. mass stalled
  // vehicles, a slide or a disaster) can strand people, so this rises well above the ordinary transport cap.
  if (source.sector === 'transport') {
    const cut = incidents.filter(isEmergencyHighwayClosure);
    if (cut.length >= 3) out.unshift({ id: `${source.id}-roads-cut`, sourceId: source.id, sector: source.sector, title: `${cut.length} highways fully closed for emergencies`, description: `Simultaneous emergency full closures: ${cut.slice(0, 6).map(i => i.title).join('; ')}. Routes in and out of the area may be cut.`, severity: 75, level: level(75), place: 'Selected area', time: Math.max(...cut.map(i => i.time)), url: source.url, status: 'Routes cut', geographic: 'regional' });
  }
  return out;
}
