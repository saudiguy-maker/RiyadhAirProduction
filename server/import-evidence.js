import fs from 'node:fs';
import { createPool, migrate } from './db.js';
import { importEvidence, validateEvidence } from './evidence.js';
const file=process.argv[2];
if(!file) throw new Error('Usage: node server/import-evidence.js reviewed-evidence.json [--check] [--licensed-for-public-display]');
const rows=validateEvidence(JSON.parse(fs.readFileSync(file,'utf8')));
if(rows.some(r=>r.sources.some(s=>s.category==='fleet_database')) && !process.argv.includes('--licensed-for-public-display'))
  throw new Error('Commercial database exports need a public-display licence. Confirm it with --licensed-for-public-display.');
if(process.argv.includes('--check')) console.log(`${rows.length} valid evidence records; database unchanged`);
else { const pool=createPool(); try {await migrate(pool); await importEvidence(pool,rows);console.log(`Imported ${rows.length} evidence records`);} finally{await pool.end();} }
