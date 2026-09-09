import { createPool, migrate } from "./db.js";
import { importSnapshots, bundledSnapshots } from "./orders.js";
const pool = createPool();
try { await migrate(pool); await importSnapshots(pool, bundledSnapshots()); }
finally { await pool.end(); }
