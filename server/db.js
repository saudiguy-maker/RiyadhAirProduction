import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Implements the six-function interface worker.js expects. Nothing in the
 * ingestion layer knows this is Postgres — swap it for SQLite and the worker
 * is unchanged.
 */
export function createDb(pool) {
  return {
    async getAirframeByHex(hex) {
      const { rows } = await pool.query(
        `SELECT id, current_stage, type_code, manufacturer, registration
           FROM airframe WHERE icao_hex = $1`, [hex]);
      return rows[0] ?? null;
    },

    async getAirframeByReg(reg) {
      const { rows } = await pool.query(
        `SELECT id, current_stage, type_code, manufacturer, registration
           FROM airframe WHERE registration = $1`, [reg]);
      return rows[0] ?? null;
    },

    async bindHex(airframeId, hex) {
      await pool.query(
        `UPDATE airframe SET icao_hex = $2, updated_at = now() WHERE id = $1`,
        [airframeId, hex]);
    },

    async createCandidate(c) {
      await pool.query(
        `INSERT INTO candidate (hex, registration, type_code, site_icao, first_seen, operator)
         VALUES ($1,$2,$3,$4,to_timestamp($5/1000.0),$6)
         ON CONFLICT (hex) DO UPDATE
           SET last_seen = now(),
               sightings = candidate.sightings + 1,
               registration = COALESCE(EXCLUDED.registration, candidate.registration)`,
        [c.hex, c.reg, c.type, c.site, c.first_seen, c.operator ?? null]);
    },

    /* ---- automatic identity resolution ---- */

    /** Unclaimed placeholder rows this registration could legitimately take. */
    async openSlots(operator, icaoType) {
      const { rows } = await pool.query(
        `SELECT id FROM airframe
          WHERE operator = $1 AND icao_type = $2
            AND registration IS NULL AND identity_source = 'projected'`,
        [operator, icaoType]);
      return rows;
    },

    async isRegTaken(reg) {
      const { rows } = await pool.query(
        `SELECT 1 FROM airframe WHERE registration = $1 LIMIT 1`, [reg]);
      return rows.length > 0;
    },

    /**
     * Claim a slot for a real aircraft. Written as one statement guarded on
     * `registration IS NULL` so two workers racing the same blip cannot both
     * win: the second UPDATE matches no rows and returns nothing.
     */
    async claimSlot(airframeId, { reg, hex, msn = null }) {
      const { rows } = await pool.query(
        `UPDATE airframe
            SET registration = $2, icao_hex = $3, msn = COALESCE($4, msn),
                identity_source = 'inferred', updated_at = now()
          WHERE id = $1 AND registration IS NULL
          RETURNING id, current_stage, type_code, icao_type, manufacturer,
                    registration, operator`,
        [airframeId, reg, hex, msn]);
      return rows[0] ?? null;
    },

    /**
     * No seeded slot exists — create the airframe from observation. Used for
     * Saudia's 787 backlog, which is real but has no published figure and so
     * is seeded at zero on purpose.
     */
    async createObservedAirframe({ operator, manufacturer, typeCode, icaoType, reg, hex }) {
      const { rows } = await pool.query(
        `INSERT INTO airframe
           (id, operator, manufacturer, type_code, icao_type, registration,
            icao_hex, identity_source, current_stage)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'observed','ORDERED')
         ON CONFLICT (registration) DO NOTHING
         RETURNING id, current_stage, type_code, icao_type, manufacturer,
                   registration, operator`,
        [`${operator}-${icaoType}-OBS-${reg}`, operator, manufacturer,
         typeCode, icaoType, reg, hex]);
      return rows[0] ?? null;
    },

    async recordBind(b) {
      await pool.query(
        `INSERT INTO identity_bind
           (airframe_id, hex, registration, operator, icao_type, site_icao,
            confidence, reason, overflow)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [b.airframe_id, b.hex, b.registration, b.operator, b.icao_type,
         b.site_icao, b.confidence, b.reason, b.overflow ?? false]);
    },

    /** Undo a binding. The airframe reverts to an empty placeholder; the
     *  stage history it accumulated is left in place but orphaned, which is
     *  visible and correctable, unlike silently deleting it. */
    async revertBind(bindId, why) {
      const { rows } = await pool.query(
        `SELECT airframe_id FROM identity_bind WHERE id = $1 AND reverted_at IS NULL`,
        [bindId]);
      if (!rows[0]) return null;
      await pool.query(
        `UPDATE airframe SET registration = NULL, icao_hex = NULL,
                identity_source = 'projected', updated_at = now()
          WHERE id = $1`, [rows[0].airframe_id]);
      await pool.query(
        `UPDATE identity_bind SET reverted_at = now(), reverted_why = $2 WHERE id = $1`,
        [bindId, why]);
      return rows[0].airframe_id;
    },

    async markCandidate(hex, { decision, reason, seenFactory }) {
      await pool.query(
        `UPDATE candidate
            SET last_decision = $2, last_reason = $3,
                seen_factory = candidate.seen_factory OR $4,
                resolved = ($2 = 'BIND')
          WHERE hex = $1`,
        [hex, decision, reason, !!seenFactory]);
    },

    async getCandidate(hex) {
      const { rows } = await pool.query(
        `SELECT * FROM candidate WHERE hex = $1`, [hex]);
      return rows[0] ?? null;
    },

    /** Candidates worth re-testing on the nightly pass. */
    async pendingCandidates(limit = 200) {
      const { rows } = await pool.query(
        `SELECT * FROM candidate
          WHERE resolved = false AND registration IS NOT NULL
          ORDER BY sightings DESC LIMIT $1`, [limit]);
      return rows;
    },

    async recentBinds(limit = 40) {
      const { rows } = await pool.query(
        `SELECT b.*, a.type_code FROM identity_bind b
           JOIN airframe a ON a.id = b.airframe_id
          ORDER BY b.bound_at DESC LIMIT $1`, [limit]);
      return rows;
    },

    async insertStageEvent(e) {
      // ON CONFLICT DO NOTHING is the permanent twin of the Redis guard.
      const { rows } = await pool.query(
        `INSERT INTO stage_event
           (airframe_id, stage, occurred_at, source, site_icao, confidence, provisional, raw_ref)
         VALUES ($1,$2,to_timestamp($3/1000.0),$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [e.airframe_id, e.stage, e.occurred_at, e.source, e.site_icao,
         e.confidence, e.provisional ?? false, e.raw_ref]);
      return rows[0]?.id ?? null;
    },

    async setStage(airframeId, stage) {
      await pool.query(
        `UPDATE airframe SET current_stage = $2, updated_at = now() WHERE id = $1`,
        [airframeId, stage]);
    },

    async recordFix(airframeId, blip) {
      await pool.query(
        `INSERT INTO position_fix (ts, airframe_id, lat, lon, alt_baro, gs, track)
         VALUES (to_timestamp($1/1000.0),$2,$3,$4,$5,$6,$7)`,
        [blip.ts, airframeId, blip.lat, blip.lon,
         Number.isFinite(+blip.alt_baro) ? +blip.alt_baro : null, blip.gs, blip.track]);
    },

    /* ---- read side, used by the API ---- */

    async roster() {
      const { rows } = await pool.query(
        `SELECT id, operator, manufacturer, type_code, msn, line_number, registration,
                test_registration, icao_hex, current_stage, identity_source,
                order_line_id, updated_at
           FROM airframe
          ORDER BY CASE current_stage
                     WHEN 'SERVICE' THEN 0 WHEN 'DELIVERY' THEN 1
                     WHEN 'CUSTOMER' THEN 2 WHEN 'PAINT' THEN 3
                     WHEN 'FIRST' THEN 4 WHEN 'GROUND' THEN 5
                     WHEN 'ROLLOUT' THEN 6 WHEN 'ASSEMBLY' THEN 7
                     WHEN 'SLOT' THEN 8 ELSE 9 END, id`);
      return rows;
    },

    async history(airframeId) {
      const { rows } = await pool.query(
        `SELECT stage, occurred_at, source, site_icao, confidence, provisional
           FROM stage_event WHERE airframe_id = $1 ORDER BY occurred_at`,
        [airframeId]);
      return rows;
    },

    async recentEvents(limit = 60) {
      const { rows } = await pool.query(
        `SELECT e.id, e.stage, e.occurred_at, e.source, e.site_icao,
                e.confidence, e.provisional, e.raw_ref,
                a.id AS airframe_id, a.type_code, a.registration,
                a.test_registration, a.msn, a.manufacturer, a.operator
           FROM stage_event e JOIN airframe a ON a.id = e.airframe_id
          ORDER BY e.occurred_at DESC LIMIT $1`, [limit]);
      return rows;
    },

    async candidates() {
      const { rows } = await pool.query(
        `SELECT * FROM candidate WHERE resolved = false ORDER BY last_seen DESC LIMIT 50`);
      return rows;
    },
  };
}

export function createPool(url = process.env.DATABASE_URL) {
  return new pg.Pool({
    connectionString: url ?? "postgres://watch:watch@localhost:5432/riyadhwatch",
    ssl: url?.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
    max: 10,
  });
}

export async function migrate(pool) {
  const sql = fs.readFileSync(path.join(__dir, "schema.sql"), "utf8");
  await pool.query(sql);
  console.log("schema applied");
}
