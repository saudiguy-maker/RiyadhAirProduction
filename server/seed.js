import { createPool, migrate } from "./db.js";
import { OPERATORS, backlogOf, TOTAL_BACKLOG } from "../ingest/config/operators.js";
import { VERIFIED, LEASED } from "../ingest/config/known-airframes.js";

/**
 * Loads four order books and the handful of airframes whose identities are
 * actually confirmed. Everything else is created with NULL msn, NULL
 * registration and stage ORDERED — deliberately empty.
 *
 * A fabricated MSN that looks right is worse than an empty field: it never
 * matches a real ADS-B contact, and it looks authoritative while doing it.
 */

async function main() {
  const pool = createPool();
  await migrate(pool);

  const { rows: existing } = await pool.query("SELECT count(*)::int AS n FROM airframe");
  if (existing[0].n > 0 && !process.argv.includes("--force")) {
    console.log(`${existing[0].n} airframes already present. Pass --force to reseed.`);
    await pool.end();
    return;
  }
  await pool.query("TRUNCATE stage_event, position_fix, airframe, order_line RESTART IDENTITY CASCADE");

  for (const op of Object.values(OPERATORS)) {
    console.log(`\n${op.name} — ${backlogOf(op.id)} airframes outstanding`);

    for (const o of op.orders) {
      if (o.qty_firm === 0) {
        console.log(`  ${o.type_code.padEnd(16)} no published backlog figure — omitted`);
        continue;
      }

      const { rows } = await pool.query(
        `INSERT INTO order_line
           (operator, manufacturer, type_code, icao_type, qty_firm, qty_options, announced_on, converted_from, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [op.id, o.manufacturer, o.type_code, o.icao_type, o.qty_firm,
         o.qty_options, o.announced_on, o.converted_from ?? null, o.note]);
      const orderId = rows[0].id;

      // Airframes with confirmed identities for this operator and type.
      const named = op.id === "RXI"
        ? VERIFIED.filter((v) => v.type === o.type_code)
        : [];

      let i = 0;
      for (const a of named) {
        const id = `${op.id}-${o.type_code}-${++i}`;
        await pool.query(
          `INSERT INTO airframe
             (id, order_line_id, operator, manufacturer, type_code, icao_type,
              msn, line_number, registration, icao_hex, current_stage, identity_source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [id, orderId, op.id, o.manufacturer, o.type_code, o.icao_type,
           a.msn, a.lineNumber, a.reg, a.hex ?? null, a.stage, a.provenance]);

        for (const e of a.events) {
          await pool.query(
            `INSERT INTO stage_event
               (airframe_id, stage, occurred_at, source, site_icao, confidence, raw_ref)
             VALUES ($1,$2,$3::date,'REGISTRY',$4,1.00,$5) ON CONFLICT DO NOTHING`,
            [id, e.stage, e.on, e.to ?? e.from ?? null, e.note ?? a.note ?? "published source"]);
        }
      }

      for (let k = named.length; k < o.qty_firm; k++) {
        await pool.query(
          `INSERT INTO airframe
             (id, order_line_id, operator, manufacturer, type_code, icao_type,
              current_stage, identity_source)
           VALUES ($1,$2,$3,$4,$5,$6,'ORDERED','projected')`,
          [`${op.id}-${o.type_code}-${k + 1}`, orderId, op.id,
           o.manufacturer, o.type_code, o.icao_type]);
      }

      console.log(`  ${o.type_code.padEnd(16)} ${String(o.qty_firm).padStart(3)}  ` +
                  `${named.length} named, ${o.qty_firm - named.length} awaiting identity`);
    }
  }

  /* Leased frames: tracked so they are not filed as unknown contacts every
     time they fly, but excluded from every order-book count. */
  for (const l of LEASED) {
    await pool.query(
      `INSERT INTO airframe
         (id, order_line_id, operator, manufacturer, type_code, icao_type,
          msn, registration, current_stage, identity_source)
       VALUES ($1,NULL,'RXI','BOEING',$2,'B789',$3,$4,$5,'verified')`,
      [`leased-${l.reg}`, l.type, l.msn, l.reg, l.stage]);
    console.log(`\n  ${l.reg} leased — tracked, excluded from counts`);
  }

  const { rows: t } = await pool.query(
    `SELECT operator,
            count(*) FILTER (WHERE order_line_id IS NOT NULL)::int AS backlog,
            count(*) FILTER (WHERE identity_source <> 'projected'
                             AND order_line_id IS NOT NULL)::int AS named
       FROM airframe GROUP BY operator ORDER BY operator`);

  console.log("\n" + "-".repeat(44));
  for (const r of t) {
    console.log(`${OPERATORS[r.operator].name.padEnd(12)} ${String(r.backlog).padStart(3)} outstanding, ${r.named} with confirmed identity`);
  }
  console.log("-".repeat(44));
  console.log(`${TOTAL_BACKLOG} airframes across ${Object.keys(OPERATORS).length} carriers. Ready.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
