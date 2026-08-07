# Murmur site

Measuring the city's heartbeat and detecting irregularities: the interactive
viewer for the Team 7 movement-change signal feed.

## Run

```powershell
npm install
npm test
npm run dev
```

The page reads the prebuilt files in `public/cop/v1/`:

- `movement-signals.geojson`
- `movement-health.json`
- `countline-coverage.geojson`

The viewer is deliberately labelled **Batch replay**. WCC publishes the source
Transport Sensors data at least monthly; this site is not live emergency
information.

Set `SITE_URL` when building for a hosted origin so Open Graph and social-card
URLs are absolute.
