/**
 * Tests for automatic identity resolution.
 *
 * The expensive failure is not "missed an aircraft" — that self-corrects on
 * the next sighting. It is "bound the wrong aircraft", which writes a false
 * history that no later observation removes. Most of what follows is
 * therefore about what the rules REFUSE to do.
 */

import { assess, chooseSlot, MIN_SIGHTINGS } from "../lib/identity.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

/** A candidate with enough sightings to clear the evidence gate. */
const proven = (over = {}) => ({
  sightings: MIN_SIGHTINGS + 2,
  first_seen: new Date(Date.now() - 60 * 60_000).toISOString(),
  seen_factory: false,
  ...over,
});

const world = (over = {}) => ({ regTaken: false, overflowAllowed: true, ...over });

console.log("\nautomatic identity resolution\n");

/* ---------- the cases it must bind ---------- */

{
  const v = assess({
    blip: { hex: "716F01", reg: "HZ-RXAH", t: "B789", flight: "BOE471", ts: Date.now() },
    place: { icao: "KCHS" }, candidate: proven(), world: world(),
  });
  ok("Riyadh Air 787 at Charleston binds", v.decision === "BIND", JSON.stringify(v));
  ok("  and is bound to Riyadh Air", v.operator === "RXI");
  ok("  with high confidence", v.confidence >= 0.95);
}

{
  const v = assess({
    blip: { hex: "3C0A01", reg: "HZ-NS12", t: "A20N", flight: "AIB021", ts: Date.now() },
    place: { icao: "EDHI" }, candidate: proven(), world: world(),
  });
  ok("flynas A320neo at Hamburg binds", v.decision === "BIND", JSON.stringify(v));
  ok("  and is bound to flynas", v.operator === "NAS");
}

{
  // Delivery ferry: no longer at the factory, but flying a Boeing callsign.
  const v = assess({
    blip: { hex: "716F02", reg: "HZ-RXAJ", t: "B78X", flight: "BOE9721", ts: Date.now() },
    place: { icao: "OERK" }, candidate: proven({ seen_factory: true }), world: world(),
  });
  ok("delivery ferry into Riyadh binds", v.decision === "BIND", JSON.stringify(v));
}

/* ---------- the cases it must refuse ---------- */

{
  // The dangerous one. Saudia has hundreds of in-service HZ-A__ narrowbodies.
  const v = assess({
    blip: { hex: "710A55", reg: "HZ-ASA1", t: "A20N", flight: "SVA1023", ts: Date.now() },
    place: { icao: "OEJN" }, candidate: proven(), world: world(),
  });
  ok("in-service Saudia A320 on a revenue flight is REJECTED",
     v.decision === "REJECT", JSON.stringify(v));
}

{
  const v = assess({
    blip: { hex: "710B01", reg: "HZ-NS44", t: "A21N", flight: "", ts: Date.now() },
    place: { icao: "OEDF" }, candidate: proven(), world: world(),
  });
  ok("Saudi-registered frame seen only at a home base is held, not bound",
     v.decision === "HOLD", JSON.stringify(v));
}

{
  const v = assess({
    blip: { hex: "A12345", reg: "N7874B", t: "B789", flight: "BOE001", ts: Date.now() },
    place: { icao: "KPAE" }, candidate: proven(), world: world(),
  });
  ok("a Boeing test registration is not one of our carriers",
     v.decision === "REJECT", JSON.stringify(v));
}

{
  const v = assess({
    blip: { hex: "716F03", reg: "HZ-RXAK", t: "B789", flight: "BOE472", ts: Date.now() },
    place: { icao: "KCHS" }, candidate: proven(), world: world({ regTaken: true }),
  });
  ok("a registration already on the roster cannot be claimed twice",
     v.decision === "REJECT", JSON.stringify(v));
}

{
  const v = assess({
    blip: { hex: "716F04", reg: "HZ-FAB", t: "B789", flight: "BOE473", ts: Date.now() },
    place: { icao: "KCHS" }, candidate: proven(), world: world({ overflowAllowed: false }),
  });
  ok("flyadeal has no 787s on order, so a 787 cannot claim a flyadeal slot",
     v.decision === "REJECT", JSON.stringify(v));
}

{
  const v = assess({
    blip: { hex: "716F05", reg: "", t: "B789", flight: "BOE474", ts: Date.now() },
    place: { icao: "KCHS" }, candidate: proven(), world: world(),
  });
  ok("no registration in the feed means hold, never guess",
     v.decision === "HOLD", JSON.stringify(v));
}

/* ---------- the evidence gate ---------- */

{
  const v = assess({
    blip: { hex: "716F06", reg: "HZ-RXAM", t: "B789", flight: "BOE475", ts: Date.now() },
    place: { icao: "KCHS" },
    candidate: { sightings: 1, first_seen: new Date().toISOString() },
    world: world(),
  });
  ok("a single sighting is held, however good the evidence",
     v.decision === "HOLD", JSON.stringify(v));
  ok("  but the pending verdict is preserved", v.pending?.decision === "BIND");
}

{
  const v = assess({
    blip: { hex: "716F07", reg: "HZ-RXAN", t: "B789", flight: "BOE476", ts: Date.now() },
    place: { icao: "KCHS" },
    candidate: { sightings: 99, first_seen: new Date(Date.now() - 60_000).toISOString() },
    world: world(),
  });
  ok("many sightings inside one minute are held — a burst is one event",
     v.decision === "HOLD", JSON.stringify(v));
}

/* ---------- Saudia's unpublished 787 backlog ---------- */

{
  const v = assess({
    blip: { hex: "710C01", reg: "HZ-AR31", t: "B789", flight: "BOE812", ts: Date.now() },
    place: { icao: "KCHS" }, candidate: proven(), world: world(),
  });
  ok("a Saudia 787 at Charleston binds despite zero seeded slots",
     v.decision === "BIND" && v.overflow === true, JSON.stringify(v));
}

{
  const v = assess({
    blip: { hex: "710C02", reg: "HZ-AR32", t: "B789", flight: "BOE813", ts: Date.now() },
    place: { icao: "KCHS" }, candidate: proven(), world: world({ overflowAllowed: false }),
  });
  ok("with overflow disabled the same aircraft is rejected, not mis-slotted",
     v.decision === "REJECT", JSON.stringify(v));
}

/* ---------- slot selection ---------- */

{
  const slot = chooseSlot([{ id: "A21N-12" }, { id: "A21N-3" }, { id: "A21N-7" }]);
  ok("slots are claimed in order, so replays are deterministic", slot.id === "A21N-3");
  ok("no slots yields null rather than throwing", chooseSlot([]) === null);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
