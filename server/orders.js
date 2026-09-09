import fs from "node:fs";
import crypto from "node:crypto";

export function validateSnapshots(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error("Expected a nonempty snapshot array");
  const keys = new Set();
  for (const r of rows) {
    for (const key of ["id", "program_key", "operator", "type_code", "scope", "note"])
      if (typeof r[key] !== "string" || !r[key].trim()) throw new Error(`Missing ${key}`);
    if (!["RXI", "SVA", "NAS", "FAD", "SVA_GROUP"].includes(r.operator)) throw new Error("Unknown operator");
    for (const key of ["as_of", "checked_on"]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r[key] ?? "") || !Number.isFinite(Date.parse(r[key])) ||
          new Date(r[key]).toISOString().slice(0,10) !== r[key]) throw new Error(`Invalid ${key}`);
    }
    if (r.as_of > r.checked_on || r.checked_on > new Date().toISOString().slice(0,10)) throw new Error("Future snapshot date");
    for (const key of ["firm_total", "delivered_total", "options_total", "pending_total"])
      if (r[key] !== null && (!Number.isInteger(r[key]) || r[key] < 0)) throw new Error(`Invalid ${key}; use null for unknown`);
    if (r.delivered_total !== null && (r.firm_total === null || r.delivered_total > r.firm_total)) throw new Error("Deliveries exceed firm orders");
    if (!Array.isArray(r.sources) || !r.sources.length) throw new Error("Source required");
    for (const s of r.sources) {
      if (!s.publisher || new URL(s.url).protocol !== "https:") throw new Error("HTTPS source and publisher required");
    }
    const key = `${r.program_key}:${r.as_of}`;
    if (keys.has(key)) throw new Error("Duplicate program/date");
    keys.add(key);
  }
  return rows;
}

export async function importSnapshots(pool, rows) {
  validateSnapshots(rows);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      const fields = ["id","program_key","operator","type_code","as_of","firm_total","delivered_total","options_total","pending_total","scope","note","sources","checked_on"];
      const values = fields.map(k => k === "sources" ? JSON.stringify(r[k]) : r[k]);
      // Immutable evidence: a conflicting revision must be explicitly reviewed.
      const digest = crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex");
      const { rows: inserted } = await client.query(
        `INSERT INTO order_snapshot (${fields.join(",")}, content_hash)
         VALUES (${values.map((_,i) => "$"+(i+1)).join(",")}, $14)
         ON CONFLICT DO NOTHING RETURNING id`, [...values, digest]);
      if (!inserted.length) {
        const { rows: old } = await client.query("SELECT content_hash FROM order_snapshot WHERE id = $1", [r.id]);
        if (old[0]?.content_hash !== digest) throw new Error(`Conflicting snapshot ${r.id}; preserve history and review a new dated revision`);
      }
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

export const bundledSnapshots = () => validateSnapshots(JSON.parse(fs.readFileSync(new URL("../data/orders.json", import.meta.url), "utf8")));
export async function orderBook(pool) {
  const { rows } = await pool.query(`SELECT DISTINCT ON (program_key) *,
    CASE WHEN firm_total IS NOT NULL AND delivered_total IS NOT NULL
      THEN firm_total - delivered_total ELSE NULL END AS remaining_at_source_date
    FROM order_snapshot ORDER BY program_key, as_of DESC`);
  return { complete: false, notice: "Dated source records; current total backlog is not yet reconciled. Group orders are shown separately to avoid double counting.", rows };
}
