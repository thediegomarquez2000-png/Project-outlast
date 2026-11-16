# OUTLAST on Vercel

Native Next.js deployment of the existing dashboard. All fifty official-source adapters, news regions, browser speed test, offline snapshot and readiness inventory are preserved. Feed cache uses Vercel Runtime Cache; seven-day observation history uses private Vercel Blob with ETag retries. Historical observations are migrated from the existing dashboard. Inventory stays local to each browser origin.

Use npm ci, npm test, npm run typecheck, npm run build. Deploy this directory as the project root. No cron or paid-plan upgrade is configured. Storage credentials are provided by the project connection and must never be committed.
