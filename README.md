# Saudi Fleet Delivery Watch

Live production, test and delivery tracking across four Saudi carriers —
444 airframes outstanding.

| Carrier | Outstanding | Types |
|---|---|---|
| Riyadh Air | 158 | 787-9, 787-10, A350-1000, A321neo |
| flynas | 171 | A320neo, A321neo, A330-900 |
| flyadeal | 61 | A320neo, A321neo, A330-900 |
| Saudia | 54 | A320neo family |

This is a **delivery** tracker, not a fleet tracker. Only aircraft still to be
handed over appear. An A320 delivered in 2014 has no meaningful position on a
production lifecycle rail, so in-service fleets are deliberately absent.

Saudia's outstanding 787-9 and 787-10 deliveries are real but carry no
published per-variant backlog figure, so that order line is seeded at zero
rather than guessed. Fill it in `ingest/config/operators.js` when a source
confirms it.

```
ingest/     ADS-B worker: geofences, providers, dedup, stage inference
server/     Postgres schema + adapter, seed, Express/WebSocket bridge
web/        React PWA, installable on an iPhone home screen
```

Milestones flow one way: ADS-B fix → geofence → binding → inference → dedup →
Postgres → WebSocket → your phone. First flight reaches the screen while the
aircraft is still climbing out.

Ten sites cannot all be swept every five seconds — the free feeds rate limit
to about one request a second. Factories sweep every tick, because first
flight is the event worth having in seconds. Delivery destinations sweep every
third tick: a delivery flight runs six to thirteen hours, so fifteen seconds
of latency on arrival is invisible.

---

## Run it locally

You need Node 20+ and Docker.

```bash
cp .env.example .env
docker compose up -d          # Postgres + Redis
npm run setup                 # installs server and web dependencies
npm run migrate               # creates the schema, seeds 158 airframes
npm test                      # 10 checks, no network needed
npm run build                 # builds the web app into web/dist
npm start                     # API + ingest + dashboard on :8080
```

Open `http://localhost:8080`. The board fills from Postgres, the feed connects
over WebSocket, and the worker begins polling the six sites.

Want the dashboard without touching live feeds — no Redis, no ADS-B calls:

```bash
INGEST=off npm start
```

During UI work, run the API and Vite separately so you get hot reload:

```bash
npm run dev:api      # terminal 1
npm run dev:web      # terminal 2, on :5173, proxies to :8080
```

---

## Put it on your iPhone

An iPhone cannot run the worker — it needs Node, Postgres and Redis running
continuously. The phone runs the dashboard; the server runs somewhere else.
Two ways to do that.

### Option A — over your own Wi-Fi, in about a minute

Good for trying it today. Both devices must be on the same network.

1. Start the server on your computer with `npm start`.
2. Find that computer's local address:
   - macOS: `ipconfig getifaddr en0`
   - Windows: `ipconfig` → IPv4 Address
   - Linux: `hostname -I`
3. On your iPhone, open **Safari** and go to `http://192.168.1.42:8080`
   (your address, not that one).
4. Tap the **Share** button — the square with the arrow, at the bottom.
5. Scroll down and tap **Add to Home Screen**, then **Add**.

You now have a Delivery Watch icon. Tapping it opens the app full screen with
no Safari chrome. It works only while you are on that Wi-Fi, and offline
caching is disabled, because iOS restricts service workers to secure origins
and this is plain HTTP.

### Option B — deployed, works anywhere

This is the real install: HTTPS, offline shell, reachable on cellular.

Any host that runs a Docker container works. Using Railway as the example,
since it provisions Postgres and Redis for you:

1. Push this folder to a GitHub repository.
2. At railway.app, create a project from that repository. It will detect the
   `Dockerfile`.
3. Add a **PostgreSQL** and a **Redis** service to the same project.
4. In your app's variables, set:
   ```
   DATABASE_URL = ${{Postgres.DATABASE_URL}}
   REDIS_URL    = ${{Redis.REDIS_URL}}
   PORT         = 8080
   ```
5. Deploy, then run the seed once from the project shell:
   ```bash
   node server/seed.js
   ```
6. Open the generated `https://….up.railway.app` **in Safari** on your iPhone.
7. **Share → Add to Home Screen → Add.**

Fly.io, Render and a plain VPS with Caddy all work the same way. The only
requirement iOS cares about is HTTPS.

### Two things to know about iOS

**It must be Safari.** Chrome and Firefox on iOS cannot add a site to the home
screen as a standalone app. Open the link in Safari first.

**Alerts do not arrive yet.** iOS supports web push only for apps already
installed to the home screen, and only with a VAPID key pair and a push
subscription stored server-side. The plumbing for that is not in this build —
it is the natural next piece if you want a buzz on your wrist the moment a
787 lifts off Charleston.

---

## What is real and what is seeded

**Real:** the order book (47 × 787-9, 20 × 787-10, 31 × A350-1000, 60 ×
A321neo, six delivered), the geofence coordinates, the ADS-B provider
endpoints, the lifecycle rules.

**Seeded:** MSNs, line numbers and registrations. These are placeholders in
`server/seed.js`. Replace them as production lists confirm real values —
until then the worker will file live aircraft as unbound candidates rather
than guess.

Candidates appear in the feed marked `unbound` and at `GET /api/candidates`.
Confirm one with:

```bash
curl -X POST http://localhost:8080/api/candidates/71C0A3/bind \
  -H 'content-type: application/json' \
  -d '{"airframe_id":"787-9-7"}'
```

## API

```
GET  /api/roster              every airframe, ordered by lifecycle position
GET  /api/events?limit=60     recent milestones, newest first
GET  /api/airframe/:id        one airframe with its full stage history
GET  /api/candidates          unbound contacts awaiting confirmation
POST /api/candidates/:hex/bind
GET  /api/health              database, client count, per-provider feed health
WS   /stream                  milestone · provisional · candidate · tick
```

## Why events do not duplicate

Four guards, each catching a different failure:

- **Redis idempotency** — `SET NX` on a hash of airframe + stage.
- **Monotonic claim** — a stage is refused unless it strictly advances.
- **Write lock** — five seconds per airframe, so racing workers cannot tie.
- **Partial unique index** — `stage_event (airframe_id, stage)` where not
  provisional. Redis is fast; this one is permanent.

Four circuits over Charleston produce one first-flight event. The test proves it.
