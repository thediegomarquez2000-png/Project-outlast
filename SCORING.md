# OUTLAST scoring (v3)

Each view uses one severity ladder but answers a different question.

| View | Question it answers | How a system is scored |
|---|---|---|
| **Bay Area** (145 km of San Jose) | How hard is life hit near me? | Worst record × proximity (full within 40 km of the event's footprint, tapering to 60% at 145 km) |
| **California** | How much of the state is disrupted, and how badly? | Severity × reach |
| **United States** | How much of the country is disrupted, and how badly? | Severity × reach |

**Index** = worst system + ¼ × each other system scoring 50 or more, capped at 100. A score of 100 means loss of life is likely and days of self-sufficiency are the best case.

## The two numbers on every record

1. **Severity (0–100)** is how bad the event is for the people inside it. These are the owner-defined reference points in `lib/alert-weights.ts`: an M6+ earthquake is 90, an evacuation order 95, power out for 10k+ customers 60, a nationwide Fed-rail failure 60, and a routine provider incident 2.
2. **People affected** comes from `lib/exposure.ts`. Each record carries a basis label:
   - `reported`: utility customer accounts × 2.5
   - `census`: population of the NWS-alerted counties (de-duplicated across overlapping alerts), or people inside an earthquake's strong-shaking radius (M5 ≈ 25 km, M6 ≈ 63 km, M7 ≈ 160 km)
   - `systemic`: cloud, payment rails and space weather, which affect the whole scope at once
   - `estimate`: fixed, labeled values for fires, evacuation zones, water notices and transport

## Power, grid and water tiers (v3.1)

PG&E usually has several outages of 1,000 or more customers somewhere in the Bay Area on an ordinary day. A single outage that size is therefore an advisory. Size or duration is what makes it serious.

| Customers out | Under 10 | 10–99 | 100–999 | 1k–9.9k | 10k–99k | 100k+ |
|---|---|---|---|---|---|---|
| Score | 4 | 10 | 25 | 35 | 60 | 85 |

Restoration estimates raise the score: 1k or more customers estimated past 24 hours scores at least 60, 10k or more past 48 hours scores at least 85, and 100k or more past 48 hours scores 95.

- **CAISO grid:** Flex Alert 20, EEA1 35, EEA2 50, EEA3 (rotating outages) 75.
- **Water:** a street-level main break scores 30, a regional emergency bulletin 35, and a boil-water or do-not-drink notice 60.

## Reach

Reach is the share of the scope's population affected at that severity or worse, on a log scale:

| Population share | 0.025% | 0.25% | 2.5% | 25%+ |
|---|---|---|---|---|
| Reach | 0 | ⅓ | ⅔ | 1 |

Records are processed from most to least severe and their people are accumulated, so many mild events touching millions and one severe event touching a few thousand are both represented. Life-threatening records (85 or higher) keep a minimum reach of 30% in the California view and 15% in the national view, so they never disappear from it.

## Peak and visibility

- **Peak event** is the worst single record before the lens is applied. The gauge shows it whenever it is 15 or more points above the index.
- **Population visible** is the share of the scope's people that each system's live feeds can see. **Confidence** is the weighted average across systems, using the sector weights in `lib/model.ts`. Power and water feeds cover California utilities only, so the national power and water readings are partial. For example, U.S. power visibility is about 11%.

## Sense check (replayed through the code)

| Scenario | Bay Area | California | U.S. |
|---|---|---|---|
| Nothing happening | 0 | 0 | 0 |
| Ordinary day: 25 small PG&E outages + one of 1,400 | 35 | 9 | 0 |
| Storm: 300 outages, 90k customers total | 38 | 27 | 9 |
| One 15k-customer outage | 60 | 12 | 0 |
| Tornado warning, Oklahoma County (OKC) | – | – | 30 (peak 92) |
| M7.0 Hayward fault | 90 | 90 | 65 |
| M7.0 Los Angeles | – | 90 | 68 |
| Hurricane warning, Miami-Dade/Broward/Palm Beach | – | – | 53 |
| PG&E PSPS, 500k customers, 3-day restoration | 60 | 67 | 37 |
| FedACH + Fedwire disrupted | 60 | 60 | 60 |
| Extreme heat warning, Central Valley + SoCal | – | 55 | 43 |
| LA M7 + 1M SCE customers out for 4 days | – | 100 | 68 |

Population data: U.S. Census county estimates (2019 vintage), from the JHU CSSE FIPS lookup table, stored in `lib/county-population.json`.
