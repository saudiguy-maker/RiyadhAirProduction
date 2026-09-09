import fs from "node:fs";
import { createPool, migrate } from "./db.js";
import { importSnapshots, validateSnapshots } from "./orders.js";
const file = process.argv[2];
if (!file) throw new Error("Usage: node server/import-orders.js reviewed-orders.json [--check]");
const rows = validateSnapshots(JSON.parse(fs.readFileSync(file, "utf8")));
if (process.argv.includes("--check")) console.log(`${rows.length} valid sourced snapshots; no database changes`);
else {
  const pool = createPool();
  try { await migrate(pool); await importSnapshots(pool, rows); console.log(`Imported ${rows.length} snapshots`); }
  finally { await pool.end(); }
}
