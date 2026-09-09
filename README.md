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
no automatic document scraper that silently overwrites announcement quantities.

## Manufacturer reports and production evidence

The application checks the official Airbus monthly XLSX and the Boeing public
Tableau CSV once per day and on startup. `REPORT_REFRESH=off` disables these
checks. The last validated versions remain available after network errors or
layout changes. `/api/research` exposes reports, attributed aircraft evidence
and source-check health. Additive startup migrations preserve existing records.

Airbus imports validate the Middle East customer rows, merged column headers,
report date and each customer's type totals against the workbook total. Blank
numeric cells are zero entries in that report. They do not prove an airline has
no orders placed by its group or a lessor. Boeing exports repeat facts for each
measure: only `Order Total` rows are aggregated. The export does not supply its
reporting cutoff, so retrieval date is explicitly separate. Manufacturer
customer totals are never added to announcements or fleet/lease counts.

Each changed manufacturer report is retained in `manufacturer_report`, keyed
by content hash. An identical retrieval does not create another version. Older
Airbus reporting periods cannot replace newer ones. Changed content for the
same reporting period remains a separate revision. To save a fresh validated
bundle locally: `npm run reports:export -- reviewed-reports.json`. Review the
output before replacing `data/manufacturer-reports.json` in the repository.

`data/evidence.json` contains selected, source-checked enthusiast reports, not
manufacturer-confirmed milestones. Evidence never updates `airframe` or
`stage_event`. Records match by manufacturer plus MSN where both have an MSN,
otherwise registration and operator; mismatches remain unbound. Date or serial
number conflicts are shown for review. The original observation group is
explicit, so reposts do not increase independent-source counts. Corrections
require a new ID with `supersedes`; the original record remains stored.

Anyone can use **Submit a sighting** to open the GitHub evidence issue form.
The issue is a review queue, not an automatic publication endpoint. Review the
original source, date, identity, independence and permitted reuse, then add a
record to `data/evidence.json` through the normal code review process. Link
photographs using `sources[].photo_url`; the application does not copy photos.
Use a direct source URL and a stable `origin_id` for each underlying sighting.
See the bundled records for the complete JSON format.

Validate an evidence file without writing to the database:
`npm run evidence:import -- reviewed-evidence.json --check`.
Without `--check`, the CLI imports it transactionally into `DATABASE_URL`.
Statuses are `reported`, `inferred`, `corroborated`, `confirmed`, or `disputed`.
Confirmed claims require primary manufacturer/airline/lessor evidence.
Corroborated claims require independent origins; stronger statuses also need a
`review_note`. A flight sighting alone is `TEST`, not `FIRST` or `CUSTOMER`.
Missing milestones stay unknown; assembly is not inferred from a later flight.

### Commercial and additional enthusiast sources

The source directory includes Planespotters reference links, ch-aviation,
Cirium and Flightradar24. No paid account is connected and no subscription is
purchased. The importer accepts reviewed exports normalized to the same
evidence schema; it is not a provider API adapter. Map a licensed sample before
using it: preserve provider identity, original dates, MSN, registration and the
actual/confirmed/estimated distinction. Keep estimated dates out of observed
milestones and use them only in explanatory notes. Commercial fleet evidence
requires `--licensed-for-public-display`; a standard internal-use subscription
does not establish redistribution rights. Do not commit source exports or keys.
Provider-specific automatic adapters remain pending licensed samples and access.

Planespotters and other enthusiast sites are references for reviewed records,
not bulk scrapers. The selected B787 Register records retain links and independent
source labels. Review new sites' access and reuse terms before enabling ingestion.

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
GET /api/research
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
