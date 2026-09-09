import test from "node:test";
import assert from "node:assert/strict";
import { IngestWorker } from "../worker.js";
import { Dedup } from "../lib/dedup.js";
import { STAGE_INDEX, inferFirstFlight } from "../lib/infer.js";
import { assess } from "../lib/identity.js";
import { ProviderPool, normalise } from "../lib/providers.js";
class MemoryRedis {
  m = new Map();
  async get(k) { return this.m.get(k) ?? null; }
  async set(k,v,...opts) { if (opts.includes("NX") && this.m.has(k)) return null; this.m.set(k,v); return "OK"; }
  async del(k) { return this.m.delete(k); }
  async keys() { return [...this.m.keys()].filter(k => k.startsWith("sortie:")); }
}
test("unbound delivery ferry passes identity evidence gate", () => {
  const v = assess({blip:{reg:"HZ-RXAZ", t:"B789",flight:"RXI9901"}, place:{icao:"OEJN"},
    candidate:{sightings:5,first_seen:new Date(Date.now()-3600000),seen_factory:true},world:{regTaken:false,overflowAllowed:true}});
  assert.equal(v.decision,"BIND");
});
test("first observation is provisional and cannot regress a delivered aircraft", () => {
  const ctx = {currentStage:"ORDERED",neverSeenBefore:true,airborne:true};
  assert.ok(inferFirstFlight({place:{icao:"KCHS"},ctx}).confidence < .8);
  assert.equal(inferFirstFlight({place:{icao:"KCHS"},ctx:{...ctx,currentStage:"SERVICE"}}),null);
});
test("13-hour coverage gap keeps departure, ground arrival closes at the actual destination", async () => {
  const redis = new MemoryRedis(); const saved = [];
  const worker = new IngestWorker({redis, providers:{health:new Map()},db:{
    getAirframeByHex: async () => ({id:"frame",current_stage:"CUSTOMER",manufacturer:"BOEING",operator:"RXI"}),
    advanceStage: async e => { saved.push(e); return 1; }, insertStageEvent: async () => 1,
  }});
  worker.on("error", e => { throw e; });
  const at = Date.now()-13*3600000;
  const base = {hex:"716FFE",reg:"HZ-RXAG",t:"B789",flight:"RXI9901",gs:200,alt_baro:2000,ts:at,lat:32.8986,lon:-80.0405};
  await worker.handle(base);
  await worker.sweepClosedSorties();
  assert.ok(await redis.get("sortie:716FFE"));
  const arrival = {...base,lat:21.6796,lon:39.1565,gs:0,alt_baro:"ground",ts:at+13*3600000};
  await worker.handle(arrival);
  assert.equal(saved.length,0);
  await worker.handle({...arrival,ts:arrival.ts+10*60000});
  assert.equal(saved.length,1); assert.equal(saved[0].stage,"DELIVERY");
  assert.match(saved[0].raw_ref,/KCHS.*OEJN/);
});
test("failed milestone commit remains retryable without a Redis claim", async () => {
  let attempts=0;
  const worker = new IngestWorker({redis:new MemoryRedis(),providers:{},db:{advanceStage:async () => { if (++attempts===1) throw new Error("offline");return 1; }}});
  const input={blip:{ts:Date.now(),flight:"RXI311"},place:{icao:"OERK"},sortie:null,airframe:{id:"x",current_stage:"DELIVERY"},neverSeenBefore:false,airborne:true};
  await assert.rejects(worker.consider(input),/offline/);
  await worker.consider(input);assert.equal(attempts,2);
});
test("feed pool excludes stale positions and retains winning provider", async () => {
  const b={hex:"ABC123",lat:1,lon:1};
  const pool = new ProviderPool([{name:"old",near:async()=>[{...b,seen:70}]},{name:"new",near:async()=>[{...b,seen:2}]}]);
  const rows=await pool.near(1,1,1);assert.equal(rows.length,1);assert.equal(rows[0].provider,"new");
  assert.equal((await new ProviderPool([{name:"stale",near:async()=>[{...b,seen:70}]}]).near(1,1,1)).length,0);
  const n=normalise({hex:"abc123",r:" hz-rxag ",seen:1,seen_pos:30});
  assert.equal(n.reg,"HZ-RXAG");assert.ok(Date.now()-n.ts>=30000);
});
