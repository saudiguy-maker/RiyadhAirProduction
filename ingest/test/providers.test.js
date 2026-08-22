import { ProviderPool } from "../lib/providers.js";
let pass=0, fail=0;
const ok=(n,c,e="")=>{ c?(pass++,console.log(`  ok   ${n}`)):(fail++,console.log(`  FAIL ${n} ${e}`)); };
const good = { name:"good", near: async()=>[{hex:"ABC123",lat:1,lon:1,seen:0}] };
const blocked = { name:"blocked", near: async()=>{ throw new Error("HTTP 403 — blocked, not transient"); } };

console.log("\nprovider pool resilience\n");
const pool = new ProviderPool([blocked, good], { failuresBeforeBench:3, benchMs:60000 });

let r = await pool.near(1,1,50);
ok("a blocked provider does not stop a working one", r.length===1, JSON.stringify(r));
ok("  and is not benched on a single failure", pool.active().length===2);

await pool.near(1,1,50); await pool.near(1,1,50);
ok("after three strikes the blocked provider is benched", pool.active().length===1);
ok("  and the working provider is untouched", pool.active()[0].name==="good");

r = await pool.near(1,1,50);
ok("data still flows once benched", r.length===1);
ok("health records why it was benched",
   pool.health.get("blocked").err.includes("403"));

const dead = new ProviderPool([blocked], { failuresBeforeBench:1, benchMs:60000 });
await dead.near(1,1,50);
let threw=false;
try { await dead.near(1,1,50); } catch(e){ threw = e.message.includes("no feed is reachable"); }
ok("with every provider benched it raises rather than reporting an empty sky", threw);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
