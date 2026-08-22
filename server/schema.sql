-- Riyadh Air Delivery Watch — schema
-- Postgres 15+. TimescaleDB optional; without it, position_fix is a plain
-- table and you should partition it by month yourself once it gets large.

CREATE TABLE IF NOT EXISTS order_line (
  id                SERIAL PRIMARY KEY,
  operator          TEXT NOT NULL DEFAULT 'RXI',   -- RXI | SVA | NAS | FAD
  manufacturer      TEXT NOT NULL,
  type_code         TEXT NOT NULL,          -- 787-9, A350-1000, ...
  icao_type         TEXT NOT NULL,          -- B789, A35K, ...
  qty_firm          INT  NOT NULL,
  qty_options       INT  NOT NULL DEFAULT 0,
  announced_on      DATE,
  converted_from    TEXT,                   -- 787-9 -> 787-10 at Farnborough
  note              TEXT
);

-- One row per airframe, never per order line. A variant conversion is an
-- UPDATE here, not a delete-and-reinsert, so the timeline survives it.
CREATE TABLE IF NOT EXISTS airframe (
  id                TEXT PRIMARY KEY,       -- '787-9-7'
  order_line_id     INT REFERENCES order_line(id),
  operator          TEXT NOT NULL DEFAULT 'RXI',
  manufacturer      TEXT NOT NULL,
  type_code         TEXT NOT NULL,
  icao_type         TEXT NOT NULL,
  msn               INT,
  line_number       INT,
  registration      TEXT UNIQUE,
  test_registration TEXT,
  icao_hex          TEXT UNIQUE,
  current_stage     TEXT NOT NULL DEFAULT 'ORDERED',
  -- verified  : registration and stage confirmed by a published source
  -- partial   : registration confirmed, MSN or line number still unknown
  -- projected : no confirmed identity; the row is a placeholder
  identity_source   TEXT NOT NULL DEFAULT 'projected',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS airframe_hex_idx   ON airframe (icao_hex);
CREATE INDEX IF NOT EXISTS airframe_stage_idx ON airframe (current_stage);
-- The operator index is NOT created here. On a database built by an earlier
-- version, `airframe` already exists without an operator column, CREATE TABLE
-- IF NOT EXISTS skips over it, and an index on a column that does not exist
-- fails the whole migration with 42703. It is created at the foot of this
-- file instead, after the ALTER statements that guarantee the column.

-- Append-only. Never UPDATE a row here; correcting history means inserting
-- a superseding event, so you can always reconstruct what you believed and when.
CREATE TABLE IF NOT EXISTS stage_event (
  id            BIGSERIAL PRIMARY KEY,
  airframe_id   TEXT NOT NULL REFERENCES airframe(id),
  stage         TEXT NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL,
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  source        TEXT NOT NULL,              -- ADSB | SPOTTER | REGISTRY | ...
  site_icao     TEXT,
  confidence    NUMERIC(3,2) NOT NULL DEFAULT 1.00,
  provisional   BOOLEAN NOT NULL DEFAULT false,
  raw_ref       TEXT
);
CREATE INDEX IF NOT EXISTS stage_event_frame_idx ON stage_event (airframe_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS stage_event_time_idx  ON stage_event (occurred_at DESC);

-- Belt and braces: the Redis guard is fast, this one is permanent.
CREATE UNIQUE INDEX IF NOT EXISTS stage_event_once
  ON stage_event (airframe_id, stage) WHERE provisional = false;

CREATE TABLE IF NOT EXISTS position_fix (
  ts            TIMESTAMPTZ NOT NULL,
  airframe_id   TEXT NOT NULL,
  lat           DOUBLE PRECISION,
  lon           DOUBLE PRECISION,
  alt_baro      INT,
  gs            REAL,
  track         REAL,
  site_icao     TEXT
);
CREATE INDEX IF NOT EXISTS position_fix_idx ON position_fix (airframe_id, ts DESC);

-- Blips that pass the type and hex filters but are not bound to an airframe.
-- A human confirms these; auto-binding poisons timelines permanently.
CREATE TABLE IF NOT EXISTS candidate (
  hex           TEXT PRIMARY KEY,
  registration  TEXT,
  operator      TEXT,
  type_code     TEXT,
  site_icao     TEXT,
  first_seen    TIMESTAMPTZ NOT NULL,
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  sightings     INT NOT NULL DEFAULT 1,
  resolved      BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS source_poll (
  source        TEXT PRIMARY KEY,
  last_ok_at    TIMESTAMPTZ,
  last_error    TEXT,
  error_count   INT NOT NULL DEFAULT 0,
  last_count    INT
);

-- Optional, only if TimescaleDB is installed:
-- CREATE EXTENSION IF NOT EXISTS timescaledb;
-- SELECT create_hypertable('position_fix','ts', if_not_exists => true);
-- SELECT add_retention_policy('position_fix', INTERVAL '90 days');

-- Safe to re-run against an existing database created before identity_source
-- existed. ALTER ... IF NOT EXISTS makes migration idempotent.
ALTER TABLE airframe ADD COLUMN IF NOT EXISTS identity_source TEXT NOT NULL DEFAULT 'projected';

ALTER TABLE order_line ADD COLUMN IF NOT EXISTS operator TEXT NOT NULL DEFAULT 'RXI';
ALTER TABLE airframe   ADD COLUMN IF NOT EXISTS operator TEXT NOT NULL DEFAULT 'RXI';
ALTER TABLE candidate  ADD COLUMN IF NOT EXISTS operator TEXT;
CREATE INDEX IF NOT EXISTS airframe_operator_idx ON airframe (operator, current_stage);

-- ---------------------------------------------------------------------------
-- Automatic identity resolution
-- ---------------------------------------------------------------------------

-- Did this candidate ever appear at a factory, paint shop or handover ramp?
-- This single flag is what separates a new-build from an in-service aircraft
-- that happens to share a registration series, so it is stored rather than
-- recomputed: the factory sighting may be hours before the one that binds.
ALTER TABLE candidate ADD COLUMN IF NOT EXISTS seen_factory BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE candidate ADD COLUMN IF NOT EXISTS last_decision TEXT;
ALTER TABLE candidate ADD COLUMN IF NOT EXISTS last_reason   TEXT;

-- Every automatic binding, with the evidence that justified it. Append-only.
-- An automatic system that cannot show its work is indistinguishable from one
-- that guesses, and a binding that cannot be undone is a permanent bet.
CREATE TABLE IF NOT EXISTS identity_bind (
  id            BIGSERIAL PRIMARY KEY,
  airframe_id   TEXT NOT NULL REFERENCES airframe(id),
  hex           TEXT NOT NULL,
  registration  TEXT NOT NULL,
  operator      TEXT NOT NULL,
  icao_type     TEXT NOT NULL,
  site_icao     TEXT,
  confidence    REAL NOT NULL,
  reason        TEXT NOT NULL,
  overflow      BOOLEAN NOT NULL DEFAULT false,
  bound_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reverted_at   TIMESTAMPTZ,
  reverted_why  TEXT
);
CREATE INDEX IF NOT EXISTS identity_bind_frame_idx ON identity_bind (airframe_id, bound_at DESC);

-- Registration is already UNIQUE on airframe, which is the database-level
-- guarantee that two aircraft can never claim the same identity no matter
-- what the inference layer believes.

CREATE INDEX IF NOT EXISTS airframe_operator_idx ON airframe (operator, current_stage);
CREATE INDEX IF NOT EXISTS airframe_slot_idx
  ON airframe (operator, icao_type, identity_source)
  WHERE registration IS NULL;
