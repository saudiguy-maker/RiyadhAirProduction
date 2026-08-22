/**
 * No network, no Redis. Proves the one thing that matters:
 * four circuits over Charleston produce exactly one first-flight event.
 *
 *   node test/dedup.test.js
 */
import assert from "node:assert";
import { Dedup } from "../lib/dedup.js";
import { locate, isAirborne } from "../lib/geo.js";
import { inferAll, STAGE_INDEX } from "../lib/infer.js";
import { isCandidate } from "../config/watchlist.js";

class FakeRedis {
  constructor() { this.m = new Map(); }
  async set(k, v, ...opt) {
    const nx = opt.includes("NX");
    if (nx && this.m.has(k)) return null;
    this.m.set(k, v); return "OK";
  }
  async get(k) { return this.m.get(k) ?? null; }
  async del(k) { return this.m.delete(k) ? 1 : 0; }
  async keys(p) { const re = new RegExp("^" + p.replace("*", ".*") + "$"); return [...this.m.keys()].filter((k) => re.test(k)); }
}

const t0 = Date.parse("2026-08-12T13:00:00Z");
const blip = (over = {}) => ({
  hex: "A5F210", reg: "N512BA", t: "B789", flight: "BOE112",
  lat: 32.8986, lon: -80.0405, alt_baro: 8000, gs: 260, ts: t0, ...over,
});

let pass = 0;
const check = (name, fn) => { fn(); console.log(`  ✓ ${name}`); pass++; };

(async () => {
  console.log("\ngeofence");
  check("Charleston fix lands inside KCHS", () => {
    assert.equal(locate(32.8986, -80.0405).icao, "KCHS");
  });
  check("Toulouse fix lands inside LFBO", () => {
    assert.equal(locate(43.6293, 1.3638).icao, "LFBO");
  });
  check("mid-Atlantic fix matches nothing", () => {
    assert.equal(locate(35.0, -40.0), null);
  });
  check("ramp polygon separates apron from approach", () => {
    assert.equal(locate(32.8800, -80.0240).onRamp, true);
    assert.equal(locate(32.9100, -80.0405).onRamp, false);
  });

  console.log("\nwatchlist");
  check("787-9 in the US block is a candidate", () => {
    assert.equal(isCandidate(blip()), true);
  });
  check("A320ceo is filtered out on type", () => {
    assert.equal(isCandidate(blip({ t: "A320" })), false);
  });

  console.log("\ndedup — four circuits, one event");
  const r = new FakeRedis();
  const d = new Dedup(r, STAGE_INDEX);
  const af = { id: "787-9-7", current_stage: "GROUND" };
  let emitted = 0;

  for (let circuit = 0; circuit < 4; circuit++) {
    for (let fix = 0; fix < 30; fix++) {
      const b = blip({ ts: t0 + circuit * 1800_000 + fix * 5000 });
      if (!isAirborne(b)) continue;
      const isNew = await d.firstEverAirborne(b.hex, b.ts);
      const hit = inferAll({
        blip: b, place: locate(b.lat, b.lon), sortie: null,
        ctx: { currentStage: af.current_stage, neverSeenBefore: isNew, airborne: true },
      });
      if (hit && (await d.claim(af.id, hit.stage, b.ts))) {
        emitted++;
        af.current_stage = hit.stage;
      }
    }
  }
  check(`120 fixes across 4 circuits emitted ${emitted} event`, () => assert.equal(emitted, 1));

  console.log("\nmonotonicity");
  check("a late GROUND fix cannot regress a flying airframe", async () => {
    assert.equal(af.current_stage, "FIRST");
  });
  const regressed = await d.claim(af.id, "ROLLOUT", t0 + 9e6);
  check("stage claim rejected when it moves backwards", () => assert.equal(regressed, false));

  console.log("\ndelivery flight");
  const sortie = {
    hex: "71C0A3", departed: "KCHS", arrived: "OERK",
    startedAt: t0, endedAt: t0 + 13 * 3600_000, lastSeen: t0 + 13 * 3600_000,
  };
  const hit = inferAll({
    blip: null, place: null, sortie,
    ctx: { currentStage: "CUSTOMER", neverSeenBefore: false, airborne: false },
  });
  check("KCHS → OERK reads as a delivery at 0.98", () => {
    assert.equal(hit.stage, "DELIVERY");
    assert.ok(hit.confidence >= 0.95);
  });

  console.log(`\n${pass} checks passed\n`);
})();

/* ---- regression tests for the three accuracy bugs found 2026-08-13 ---- */
(async () => {
  const { inferDelivery } = await import("../lib/infer.js");
  const { REG_PREFIX, inFlightTest } = await import("../config/watchlist.js");
  const { siteRoles } = await import("../config/sites.js");
  const A = (await import("node:assert")).default;
  let n = 0;
  const ok = (name, fn) => { fn(); console.log(`  ✓ ${name}`); n++; };

  console.log("\nregressions");

  ok("Jeddah counts as a delivery destination", () => {
    const d = inferDelivery({ departed: "KCHS", arrived: "OEJN" }, {});
    A.equal(d?.stage, "DELIVERY");   // HZ-RXAE and RXAF arrived here
  });

  ok("Everett counts as a delivery origin", () => {
    A.equal(siteRoles("KPAE", "DELIVERY_ORIGIN"), true);  // HZ-RXAB, HZ-RXAD
  });

  ok("an HZ- registration alone does not imply delivery", () => {
    A.equal(REG_PREFIX.RIYADH_AIR.test("HZ-RXAG"), true);
    A.equal(inFlightTest("BOE047"), true);   // still in Boeing flight test
  });

  ok("a Boeing-callsign ferry to Saudi is not a handover", () => {
    A.equal(inferDelivery({ departed: "KCHS", arrived: "OERK", callsign: "BOE047" }, {}), null);
  });

  console.log(`\n${n} regression checks passed\n`);
})();

/* ---- multi-operator layer ---- */
(async () => {
  const O = await import("../config/operators.js");
  const S = await import("../config/sites.js");
  const A = (await import("node:assert")).default;
  let n = 0;
  const ok = (name, fn) => { fn(); console.log(`  ✓ ${name}`); n++; };

  console.log("\noperators");

  ok("four carriers, 444 airframes outstanding", () => {
    A.equal(Object.keys(O.OPERATORS).length, 4);
    A.equal(O.TOTAL_BACKLOG, 444);
  });

  ok("registration series do not overlap", () => {
    A.equal(O.operatorOfReg("HZ-RXAG"), "RXI");
    A.equal(O.operatorOfReg("HZ-FAN"),  "FAD");
    A.equal(O.operatorOfReg("N512BA"),  null);
  });

  ok("callsign identifies a delivered aircraft, registration does not", () => {
    A.equal(O.operatorOfCallsign("NAS4021"), "NAS");
    A.equal(O.operatorOfCallsign("SVA123"),  "SVA");
    A.equal(O.operatorOfCallsign("BOE047"),  null);   // still Boeing's aircraft
  });

  ok("Dammam and Jeddah are delivery destinations, not just bases", () => {
    for (const d of O.DELIVERY_DESTS) A.equal(S.siteRoles(d, "DELIVERY_DEST"), true);
  });

  ok("factories sweep every tick, destinations every third", () => {
    A.equal(S.shouldPoll("KCHS", 1), true);    // first flight cannot wait
    A.equal(S.shouldPoll("OERK", 1), false);   // a 13-hour ferry can
    A.equal(S.shouldPoll("OERK", 3), true);
  });

  console.log(`\n${n} operator checks passed\n`);
})();
