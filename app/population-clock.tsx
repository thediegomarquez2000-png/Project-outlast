'use client';
import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import type { Scope } from '../lib/model';
import { CLOCKS, projectPopulation } from '../lib/population-clock';

const fmt = (n: number) => n.toLocaleString('en-US');
const every = (s: number) => s >= 60 ? `${(s / 60).toFixed(1)} min` : `${s.toFixed(s < 10 ? 1 : 0)} s`;

export function PopulationClock({ scope }: { scope: Scope }) {
  // Rendered only after mount so the server and browser never disagree about the current second.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => { setNow(Date.now()); const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const clock = CLOCKS[scope];
  const p = now === null ? null : projectPopulation(scope, now);
  return <section className="panel population-clock" aria-label={`Projected population, ${clock.label}`}>
    <div className="panel-head"><div><span className="eyebrow">POPULATION IN VIEW · PROJECTION</span><h2><Users size={16}/>{clock.label}</h2></div></div>
    <div className="population-stats" aria-live="off">
      <div className="population-main"><span>Projected population</span><b>{p ? fmt(p.population) : '—'}</b></div>
      <div><span>Born today</span><b>{p ? fmt(p.bornToday) : '—'}</b><small>about 1 every {p ? every(p.secondsPerBirth) : '—'} · {p ? fmt(p.birthsPerDay) : '—'}/day</small></div>
      <div><span>Died today</span><b>{p ? fmt(p.diedToday) : '—'}</b><small>about 1 every {p ? every(p.secondsPerDeath) : '—'} · {p ? fmt(p.deathsPerDay) : '—'}/day</small></div>
    </div>
    <p className="tool-fineprint">Projection from official estimates at average rates, counted from midnight Pacific time. Not a live count, and the deaths figure is the ordinary daily average, not casualties from any incident. Source: {clock.source}.</p>
  </section>;
}
