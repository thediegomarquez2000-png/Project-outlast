// Population clock: a PROJECTION, not a live count. Each area starts from an official estimate and is rolled
// forward at average annual rates, the same method as the Census Bureau's own population clock. It does not
// react to events, and its deaths figure is the ordinary daily average, never casualties from an incident.
import type { Scope } from './model';

export interface ClockSpec {
  label: string;
  base: number;            // official estimate at baseDate
  baseDate: string;        // ISO date of that estimate
  birthsPerYear: number;
  deathsPerYear: number;
  migrationPerYear: number; // net migration (international + domestic where published)
  source: string;
}
const YEAR_S = 365.25 * 86400;
export const CLOCKS: Record<Scope, ClockSpec> = {
  // Census Bureau New Year's 2025 release: one birth every 9 s, one death every 9.4 s, one net international migrant every 23.2 s.
  us: { label: 'United States', base: 341_145_670, baseDate: '2025-01-01T00:00:00Z', birthsPerYear: YEAR_S / 9, deathsPerYear: YEAR_S / 9.4, migrationPerYear: YEAR_S / 23.2, source: 'U.S. Census Bureau population clock, Jan 1 2025 release' },
  // Census Vintage 2024 estimate; approximate annual births, deaths and net migration for California.
  ca: { label: 'California', base: 39_431_263, baseDate: '2024-07-01T00:00:00Z', birthsPerYear: 400_000, deathsPerYear: 285_000, migrationPerYear: 117_000, source: 'U.S. Census Bureau Vintage 2024 estimate; approximate CA birth, death and migration totals' },
  // Counties within 145 km of San Jose (the Bay Area view), Census 2019 county estimates, at California's per-capita
  // birth (10.1 per 1,000) and death (7.2 per 1,000) rates. Net migration is not projected (the region was roughly flat).
  bay: { label: 'Bay Area (145 km of San Jose)', base: 11_157_670, baseDate: '2019-07-01T00:00:00Z', birthsPerYear: 11_157_670 * 0.0101, deathsPerYear: 11_157_670 * 0.0072, migrationPerYear: 0, source: 'U.S. Census Bureau 2019 county estimates at California birth and death rates' },
};

/** Seconds since local midnight in the Pacific time zone. */
export function secondsSincePacificMidnight(now: number) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).map(p => [p.type, p.value]));
  return Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
}

export function projectPopulation(scope: Scope, now = Date.now()) {
  const c = CLOCKS[scope];
  const elapsed = (now - Date.parse(c.baseDate)) / 1000;
  const perSecond = (c.birthsPerYear - c.deathsPerYear + c.migrationPerYear) / YEAR_S;
  const today = secondsSincePacificMidnight(now);
  return {
    population: Math.round(c.base + perSecond * elapsed),
    bornToday: Math.floor(c.birthsPerYear / YEAR_S * today),
    diedToday: Math.floor(c.deathsPerYear / YEAR_S * today),
    birthsPerDay: Math.round(c.birthsPerYear / 365.25),
    deathsPerDay: Math.round(c.deathsPerYear / 365.25),
    secondsPerBirth: YEAR_S / c.birthsPerYear,
    secondsPerDeath: YEAR_S / c.deathsPerYear,
  };
}
