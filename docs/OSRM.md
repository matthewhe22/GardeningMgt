# Self-hosting OSRM for road-distance routing

Route optimization (Routes page, Jobs-page “Optimize route”, dashboard
“Optimize my day”) orders each gardener’s stops by **driving distance** using
[OSRM](https://project-osrm.org/) — free, no API key, no live traffic (static
road network).

By default the app uses OSRM’s **public demo server**
(`https://router.project-osrm.org`). That’s fine to start with, but it’s
rate-limited and “for development, not production”. If you get throttled you’ll
simply see the straight-line fallback (the Routes page says so). When you want
reliability, run your own OSRM and point the app at it with the `OSRM_URL`
environment variable.

> The app only calls OSRM’s **Table** service (a distance matrix). Any OSRM
> instance built with the car profile works.

---

## Option A — Docker (recommended)

You need ~2–8 GB RAM and disk depending on the extract. Victoria alone is small;
all of Australia is a few GB.

### 1. Download a regional extract (OSM `.pbf`)

Smaller = faster to build and less RAM. Use the smallest extract that covers
your service area. From [Geofabrik](https://download.geofabrik.de/):

```bash
mkdir osrm && cd osrm
# Victoria only (smallest that covers Melbourne):
curl -O https://download.geofabrik.de/australia-oceania/australia/victoria-latest.osm.pbf
# …or all of Australia if you operate across states:
# curl -O https://download.geofabrik.de/australia-oceania/australia-latest.osm.pbf
```

### 2. Pre-process with the car profile

```bash
PBF=victoria-latest.osm.pbf

docker run -t -v "${PWD}:/data" osrm/osrm-backend \
  osrm-extract -p /opt/car.lua /data/${PBF}

docker run -t -v "${PWD}:/data" osrm/osrm-backend \
  osrm-partition /data/${PBF%.osm.pbf}.osrm

docker run -t -v "${PWD}:/data" osrm/osrm-backend \
  osrm-customize /data/${PBF%.osm.pbf}.osrm
```

(`extract` is the slow/RAM-hungry step; `partition` + `customize` are the MLD
pipeline used by `osrm-routed --algorithm mld`.)

### 3. Run the server

```bash
docker run -d --name osrm --restart unless-stopped -p 5000:5000 \
  -v "${PWD}:/data" osrm/osrm-backend \
  osrm-routed --algorithm mld --max-table-size 1000 /data/victoria-latest.osrm
```

- `-p 5000:5000` exposes the HTTP API on port 5000.
- `--max-table-size 1000` lets the Table service handle up to 1000 coordinates
  per request (the default is 100 — plenty for a day’s stops, but raise it if a
  gardener ever has 100+ in one go).

### 4. Smoke-test

```bash
# Two points in Melbourne → JSON with a "distances" matrix in metres
curl "http://localhost:5000/table/v1/driving/144.9631,-37.8136;144.9780,-37.8200?annotations=distance"
```

You should get `{"code":"Ok", ... "distances":[[0, ...],[...]]}`. Note OSRM uses
**lon,lat** order.

### 5. Point the app at it

Set the env var (Vercel → Project → Settings → Environment Variables, or your
server’s env) and redeploy/restart:

```
OSRM_URL=https://osrm.your-domain.com
```

- Use **https** in production — the app runs over https and mixed-content/cert
  issues will make the call fail (and silently fall back to straight-line).
- Put the container behind a reverse proxy (Caddy/Nginx) for TLS, and restrict
  access (firewall/allowlist) since OSRM has no auth of its own.
- Refresh the data periodically (monthly is plenty) by re-downloading the
  extract and re-running step 2.

---

## Option B — A hosted OSRM / matrix provider

If you’d rather not run a server, several providers expose an OSRM-compatible
(or matrix) API. As long as the base URL answers
`/table/v1/driving/{coords}?annotations=distance`, just set `OSRM_URL` to it.
Anything that needs an API key or a different request shape would need a small
adapter in `src/roadDistance.js` — open an issue / ask and it can be added.

---

## How the app behaves

- **Configured & reachable:** stops are ordered by road distance; the Routes
  page shows *“optimized by driving distance (road network)”*.
- **Unreachable / throttled / not configured:** it automatically falls back to
  straight-line distance and shows an amber note. Optimization never fails.
- Tune the request timeout indirectly by keeping extracts regional (smaller =
  faster responses). Relevant env vars: `OSRM_URL`, `OSRM_USER_AGENT`.

See `src/roadDistance.js` (the OSRM call) and `src/routeOptimizer.js`
(`optimizeRouteRoad`, with the straight-line fallback).
