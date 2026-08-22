/**
 * How an unknown blip inside a geofence becomes "Riyadh Air MSN 68103".
 *
 * Three filters, applied in order, cheapest first:
 *   1. TYPE   — is it even one of our four types?
 *   2. ORIGIN — is the hex in a block that could plausibly be ours?
 *   3. BIND   — does it map to a known airframe, or is it a new candidate?
 *
 * Nothing here asserts an aircraft IS ours. Filters 1–2 produce candidates;
 * binding to an airframe happens in lib/bind.js against the roster table.
 */

/** ICAO type designators for the order book. */
export const FLEET_TYPES = {
  B789: { type: "787-9",     mfr: "BOEING" },
  B78X: { type: "787-10",    mfr: "BOEING" },
  A35K: { type: "A350-1000", mfr: "AIRBUS" },
  A21N: { type: "A321neo",   mfr: "AIRBUS" },
  A20N: { type: "A320neo",   mfr: "AIRBUS" },
  A339: { type: "A330-900",  mfr: "AIRBUS" },
};

/**
 * ICAO 24-bit address blocks, as allocated by ICAO Annex 10 Vol III.
 * Test aircraft wear the manufacturer country's block; delivered aircraft
 * are re-hexed into the Saudi block. Watching both catches the handover.
 */
export const HEX_BLOCKS = {
  SAUDI:  { from: 0x710000, to: 0x717fff, note: "HZ- registrations, post-delivery" },
  USA:    { from: 0xa00000, to: 0xafffff, note: "N-number Boeing test regs" },
  FRANCE: { from: 0x380000, to: 0x3bffff, note: "F-W** Airbus test regs" },
  GERMANY:{ from: 0x3c0000, to: 0x3fffff, note: "D-A** Hamburg-built test regs" },
};

export const hexBlockOf = (hex) => {
  const n = parseInt(hex, 16);
  if (Number.isNaN(n)) return null;
  for (const [name, b] of Object.entries(HEX_BLOCKS)) {
    if (n >= b.from && n <= b.to) return name;
  }
  return null;
};

/**
 * Callsign patterns. Test flights use manufacturer callsigns; revenue
 * flights use the operator's. The transition from one to the other is
 * itself the in-service signal.
 */
export const CALLSIGNS = {
  BOEING_TEST: /^BOE\d{1,3}$/,        // BOE123
  AIRBUS_TEST: /^AIB\d{2,4}$/,        // AIB01A style varies; keep loose
  FERRY:       /^(FDX|GTI|BOE|AIB)/,  // rarely relevant, kept for exclusion
  RIYADH_AIR:  /^RXI\d{1,4}$/,        // ICAO designator RXI
};

/** Explicit hex→airframe bindings, seeded manually or from production lists.
 *  Anything not in here that passes the type + block filters is written to
 *  the `candidate` table for human confirmation rather than auto-bound. */
export const KNOWN_HEX = {
  // "71C0A3": { airframe_id: "787-9-7", msn: 68106 },
};

/**
 * Registration patterns.
 *
 * CORRECTION, 2026-08-13: an earlier version of this file treated an HZ-
 * registration as proof of delivery. That is wrong, and it matters.
 *
 * HZ-RXAG was flying Boeing test sorties out of Charleston in July 2026
 * wearing its Saudi registration AND a Saudi hex (716FFE) under the Boeing
 * callsign BOE047 — four flights before anyone handed it over. Riyadh Air
 * frames are registered in Saudi Arabia before flight test, not after.
 *
 * So registration tells you WHICH airframe. Only the callsign and the
 * flight profile tell you what has happened to it.
 */
export const REG_PREFIX = {
  SAUDI_CARRIER: /^HZ-[A-Z0-9]{2,4}$/, // any Saudi carrier — identity only
  RIYADH_AIR:  /^HZ-RX[A-Z]{2}$/,  // identity only — implies nothing about stage
  BOEING_TEST: /^N\d{3}BA$/,       // Boeing house regs, used for some frames
  AIRBUS_TEST: /^F-W/,
};

/** An aircraft under a manufacturer callsign has NOT been handed over,
 *  whatever registration it is wearing. */
export const inFlightTest = (callsign) => {
  const cs = (callsign ?? "").trim().toUpperCase();
  return CALLSIGNS.BOEING_TEST.test(cs) || CALLSIGNS.AIRBUS_TEST.test(cs);
};

export const isFleetType = (t) => Boolean(FLEET_TYPES[t]);

/** A blip is a candidate if the type matches and the hex block is one a
 *  Riyadh Air frame could wear at some point in its life. */
export function isCandidate(blip) {
  if (!isFleetType(blip.t)) return false;
  const block = hexBlockOf(blip.hex);
  if (!block) return false;
  if (block === "SAUDI") return true;
  // Test-block frames only count when they are at a site that builds our types.
  return ["USA", "FRANCE", "GERMANY"].includes(block);
}
