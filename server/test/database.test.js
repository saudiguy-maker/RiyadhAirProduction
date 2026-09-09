import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { createDb, migrate } from "../db.js";
import { bundledSnapshots, importSnapshots, orderBook, validateSnapshots } from "../orders.js";

test("migrate legacy database twice, preserve records, import evidence, and advance atomically", async () => {
  const pg = new PGlite();
  const query = async (sql, params) => params === undefined
    ? (await pg.exec(sql)).at(-1) : pg.query(sql, params);
  const pool = { query, connect: async () => ({ query, release() {} }) };
  try {
    await pg.exec(fs.readFileSync(new URL("../../schema.sql", import.meta.url), "utf8"));
    await pg.query(`INSERT INTO airframe (id, manufacturer, type_code, icao_type, current_stage)
      VALUES ('old', 'BOEING', '787-9', 'B789', 'CUSTOMER')`);
    await migrate(pool); await migrate(pool);
    assert.equal((await pg.query("SELECT current_stage FROM airframe WHERE id = 'old'")).rows[0].current_stage, "CUSTOMER");
    const db = createDb(pool);
    const e = { airframe_id: "old", stage: "DELIVERY", occurred_at: Date.now(), source: "ADSB", site_icao: "OEJN", confidence: .98, raw_ref: "test" };
    assert.ok(await db.advanceStage(e));
    assert.equal(await db.advanceStage(e), null);
    assert.equal(await db.advanceStage({ ...e, stage: "FIRST" }), null);
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM stage_event")).rows[0].n, 1);
    assert.equal((await db.roster())[0].current_stage, "DELIVERY");
    await assert.rejects(db.advanceStage({ ...e, stage: "SERVICE", source: null }));
    assert.equal((await db.roster())[0].current_stage, "DELIVERY");
    assert.ok(await db.advanceStage({ ...e, stage: "SERVICE" }));
    const provisional = { ...e, stage: "GROUND", provisional: true };
    assert.ok(await db.insertStageEvent(provisional));
    assert.equal(await db.insertStageEvent(provisional), null);
    await db.recordFix("old", {ts:e.occurred_at,lat:1,lon:1,alt_baro:"ground",gs:0,track:0});
    await db.recordFix("old", {ts:e.occurred_at,lat:1,lon:1,alt_baro:"ground",gs:0,track:0});
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM position_fix")).rows[0].n,1);
    const rows = bundledSnapshots();
    await importSnapshots(pool, rows); await importSnapshots(pool, rows);
    const book = await orderBook(pool);
    assert.equal(book.rows.length, rows.length);
    assert.equal(book.rows.find(r => r.program_key === "rxi-787").remaining_at_source_date, 44);
    assert.equal(book.rows.find(r => r.operator === "SVA").remaining_at_source_date, null);
    assert.equal(book.complete, false);
    await assert.rejects(importSnapshots(pool, [{ ...rows[0], firm_total: 999 }]), /Conflicting/);
    assert.equal((await orderBook(pool)).rows.find(r => r.program_key === "rxi-787").firm_total, 50);
  } finally { await pg.close(); }
});

test("invalid, duplicate, and unsourced order snapshots cannot be imported", () => {
  const row = bundledSnapshots()[0];
  for (const change of [{sources: []}, {firm_total: -1}, {delivered_total: 999}, {options_total: undefined}, {as_of: "2026-02-30"}])
    assert.throws(() => validateSnapshots([{ ...row, ...change }]));
  assert.throws(() => validateSnapshots([row,row]));
});
