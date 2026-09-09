# Saudi Fleet Delivery Watch

Tracks aircraft observations for Riyadh Air, Saudia, flynas and flyadeal,
with a separate, sourced order ledger. **It does not yet establish a complete
current backlog for all four airlines.** Unknown balances are shown as unknown.

## Run

Node 20+, PostgreSQL 15+ and Redis are required for live ingestion.

```sh
npm run setup
npm run build
npm run migrate
npm start
```

Set `DATABASE_URL`, `REDIS_URL` and optionally `PORT` (default 8080).
`docker compose up -d` starts the local databases. Startup runs idempotent
schema upgrades and imports bundled source records without reseeding aircraft.
The Docker image includes those records. Set `INGEST=off` to browse the database
without polling ADS-B. On Windows PowerShell use `$env:INGEST = "off"`.

`npm run seed` can load the older named-aircraft records on an empty database.
It no longer creates hundreds of unnamed aircraft. Those older identities
and dates still need per-aircraft source reconciliation. Never run `reseed`
on a production database unless you intend to delete aircraft history.

## What the numbers mean

- **Sourced order book:** dated manufacturer announcements, with firm orders,
  pending commitments, options, delivery totals and source links kept apart.
  A null value means unknown. A remaining balance is calculated only when
  firm and delivered totals are both supplied for the same snapshot/scope.
- **Observed aircraft:** identified records, including recorded handovers.
  Delivery and service both count as handovers. These are observations, not
  a substitute for manufacturer order totals. Leased aircraft are excluded.
- **Legacy placeholders:** old unallocated rows are preserved but hidden by
  default and explicitly marked unreconciled. No hard-coded 444-aircraft total.
- **Group orders:** the Saudia/flyadeal group announcement is shown separately;
  it is not summed again into airline totals.

The July 20, 2026 Boeing announcement supports 50 firm Riyadh Air 787s
(67 less 17 pending), with six delivered at that date. It does not establish
the current variant-level backlog. This distinction is preserved in the data.

## Updating order sources

`data/orders.json` contains the reviewed baseline. Each record has a stable
program key, source date, scope, verification date and HTTPS publisher links.
Older snapshots remain in the database; the API selects the newest date per
program. Do not import overlapping contracts under different keys and sum them.
The app deliberately does not publish an aggregate current backlog.

```sh
node server/import-orders.js reviewed-orders.json --check
node server/import-orders.js reviewed-orders.json
```

The first command validates without writing. The second imports the batch
transactionally. Reimporting the same evidence is safe; changing an existing
snapshot is rejected. A later dated revision uses a new ID and the same
program key. `npm run migrate` imports the bundled records without reseeding.

Use [Airbus monthly orders and deliveries](https://www.airbus.com/en/products-services/commercial-aircraft/orders-and-deliveries),
Boeing announcements and airline releases for reconciliation. A press release
is an order-date source, not proof of today's outstanding balance. There is
no automatic document scraper that silently overwrites quantities.

## Flight sources and reliability

The worker combines adsb.fi and adsb.lol; airplanes.live is optional via
`USE_AIRPLANES_LIVE=true`. ADS-B Exchange is optional with `RAPIDAPI_KEY`.
All adapters have request timeouts. Position age is respected, observations
older than 60 seconds are discarded, and each event retains its provider.
`source_poll` retains provider health; the UI distinguishes disabled, stale,
partial and working feeds. An open WebSocket alone does not mean live coverage.

Airport observations cannot prove an aircraft's actual first flight. First
observations therefore remain provisional. Long flights retain their departure
for up to 24 hours across coverage gaps. An arrival needs sustained ground
observations. A lost Redis instance can still lose an active flight; it cannot
move the persistent aircraft stage backwards.

Milestones and stage changes commit in one PostgreSQL transaction under a row
lock. A failed write can be retried; Redis no longer consumes the event first.
Reconnecting clients fetch a fresh snapshot, including newly identified aircraft.

## API

```
GET /api/orders
GET /api/roster
GET /api/events?limit=60
GET /api/airframe/:id
GET /api/candidates
GET /api/identity
GET /api/health
WS  /stream
```

The existing bind/revert write endpoints remain administrative operations;
keep them behind your deployment's access controls.

## Validation

`npm test` runs every ingestion suite plus database and dashboard model tests.
Database tests use embedded PostgreSQL (PGlite) to exercise legacy migrations,
transaction rollback, monotonic stages, duplicate events and immutable imports.
`npm run build` builds the React app. Tests do not require live ADS-B or external
PostgreSQL/Redis services.
