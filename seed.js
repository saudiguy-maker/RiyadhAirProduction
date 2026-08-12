import { createPool, migrate, createDb } from "./db.js";

/**
 * The firm order book as it stands after Farnborough 2026.
 * Options are recorded but do not generate airframe rows — an airframe
 * exists here only once it is firm.
 */
const ORDERS = [
  { manufacturer: "BOEING", type_code: "787-9",     icao_type: "B789", qty_firm: 47, qty_options: 0,
    announced_on: "2023-03-14", note: "original 2023 order, less 20 converted to -10" },
  { manufacturer: "BOEING", type_code: "787-10",    icao_type: "B78X", qty_firm: 20, qty_options: 0,
    announced_on: "2026-07-20", converted_from: "787-9", note: "Farnborough 2026 variant conversion" },
  { manufacturer: "AIRBUS", type_code: "A350-1000", icao_type: "A35K", qty_firm: 31, qty_options: 19,
    announced_on: "2025-06-17", note: "25 firm at Paris 2025, +6 at Farnborough 2026" },
  { manufacturer: "AIRBUS", type_code: "A321neo",   icao_type: "A21N", qty_firm: 60, qty_options: 0,
    announced_on: "2024-05-01", note: "narrowbody backbone" },
];

/** Starting MSN and line-number blocks. Adjust as production lists confirm. */
const BLOCKS = {
  "787-9":     { msn: 68100, ln: 1290 },
  "787-10":    { msn: 68400, ln: 1340 },
  "A350-1000": { msn: 780,   ln: null },
  "A321neo":   { msn: 12400, ln: null },
};

/** Frames already past ORDERED. Six 787-9s delivered as of August 2026. */
const SEEDED_STAGES = {
  "787-9": ["SERVICE","SERVICE","SERVICE","SERVICE","SERVICE","SERVICE",
            "DELIVERY","CUSTOMER","PAINT","FIRST","FIRST","GROUND","ROLLOUT",
            "ASSEMBLY","ASSEMBLY","ASSEMBLY","SLOT","SLOT","SLOT","SLOT","SLOT"],
  "787-10": ["ASSEMBLY","SLOT","SLOT","SLOT"],
  "A350-1000": ["ASSEMBLY","ASSEMBLY","SLOT","SLOT","SLOT","SLOT"],
  "A321neo": ["GROUND","ROLLOUT","ROLLOUT","ASSEMBLY","ASSEMBLY","ASSEMBLY",
              "ASSEMBLY","SLOT","SLOT","SLOT","SLOT","SLOT","SLOT","SLOT","SLOT"],
};

const ORDER = ["ORDERED","SLOT","ASSEMBLY","ROLLOUT","GROUND","FIRST","PAINT","CUSTOMER","DELIVERY","SERVICE"];
const idx = (s) => ORDER.indexOf(s);

async function main() {
  const pool = createPool();
  await migrate(pool);
  const db = createDb(pool);

  const { rows: existing } = await pool.query("SELECT count(*)::int AS n FROM airframe");
  if (existing[0].n > 0 && !process.argv.includes("--force")) {
    console.log(`${existing[0].n} airframes already present. Pass --force to reseed.`);
    await pool.end();
    return;
  }
  if (process.argv.includes("--force")) {
    await pool.query("TRUNCATE stage_event, position_fix, airframe, order_line RESTART IDENTITY CASCADE");
  }

  let delivered = 0;
  for (const o of ORDERS) {
    const { rows } = await pool.query(
      `INSERT INTO order_line (manufacturer, type_code, icao_type, qty_firm, qty_options, announced_on, converted_from, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [o.manufacturer, o.type_code, o.icao_type, o.qty_firm, o.qty_options,
       o.announced_on, o.converted_from ?? null, o.note]);
    const orderId = rows[0].id;

    const stages = SEEDED_STAGES[o.type_code] ?? [];
    const block = BLOCKS[o.type_code];

    for (let i = 0; i < o.qty_firm; i++) {
      const stage = stages[i] ?? "ORDERED";
      const si = idx(stage);
      const id = `${o.type_code}-${i + 1}`;
      const hasSlot = si >= idx("SLOT");
      const isDelivered = si >= idx("DELIVERY");

      await pool.query(
        `INSERT INTO airframe
           (id, order_line_id, manufacturer, type_code, icao_type, msn, line_number,
            registration, test_registration, current_stage)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, orderId, o.manufacturer, o.type_code, o.icao_type,
         hasSlot ? block.msn + i : null,
         hasSlot && block.ln ? block.ln + i : null,
         isDelivered ? `HZ-R${String(++delivered).padStart(2, "0")}` : null,
         si >= idx("FIRST") && !isDelivered
           ? (o.manufacturer === "BOEING" ? `N${500 + i}BA` : `F-WZ${String.fromCharCode(65 + (i % 26))}`)
           : null,
         stage]);

      // Backfill a plausible history so the board is not empty on first load.
      for (let k = 1; k <= si; k++) {
        const daysAgo = (si - k + 1) * (4 + (i % 6));
        await pool.query(
          `INSERT INTO stage_event (airframe_id, stage, occurred_at, source, confidence, raw_ref)
           VALUES ($1,$2, now() - ($3 || ' days')::interval, $4, 1.00, 'seed')
           ON CONFLICT DO NOTHING`,
          [id, ORDER[k], String(daysAgo),
           k >= idx("FIRST") ? "ADSB" : k >= idx("ROLLOUT") ? "SPOTTER" : "PRODUCTION_LIST"]);
      }
    }
    console.log(`seeded ${o.qty_firm} × ${o.type_code}`);
  }

  const { rows: total } = await pool.query("SELECT count(*)::int AS n FROM airframe");
  console.log(`\n${total[0].n} airframes, ${delivered} delivered. Ready.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
