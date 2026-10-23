# Kerb

A map of Sydney's kerbs: where you can park right now, what the meters cost, and how long you can stay.

## How it works

- `scripts/fetch-data.mjs` downloads City of Sydney open data: every parking meter (with its sign rules), meter rate areas, resident permit areas, free 15-minute zones, council car parks and street centrelines.
- `scripts/build-data.mjs` reads each meter's sign text (for example `2P 8AM-6PM MON-FRI, $7 /HR`), matches meters to the street they sit on, and writes compact kerb segments to `public/data/`.
- The app (`src/`) colours every kerb for the day, time and length of stay you pick, ranks free and cheap options near the middle of the map, and shows each street's rules across the week.
- GitHub Actions rebuilds the data and redeploys every night.

## Run it locally

```
npm install
npm run data      # download and build the parking data
npm run dev
```

## Data sources

- City of Sydney open data: parking meters, ticket parking rates, parking permit areas, free 15 minute parking, council car parks, street codes.
- Base map: OpenFreeMap, built on OpenStreetMap.

Car park prices can be added by hand in `data/carparks.json` (name, `at` [lon, lat], `bands` [[hours, price]...], `earlyBird`, `night`, `weekend`, `checked`).

## Next data

- Waverley Council traffic and parking signs (Bondi), via the TfNSW Open Data Hub (needs an API key saved as the `TFNSW_API_KEY` repository secret).
- TfNSW Car Park API for live car park spaces.
- Mapillary street-level sign detections for suburbs without published sign data.
- Driver reports for real busyness.
