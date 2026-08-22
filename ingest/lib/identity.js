/**
 * IDENTITY — turning an unknown blip into a named airframe, automatically.
 *
 * The original design sent every unrecognised aircraft to a human review
 * queue, on the grounds that a wrong binding poisons a timeline permanently.
 * That reasoning still holds. What changed is that we no longer treat "ask a
 * human" as the only alternative to guessing: we gate binding behind evidence
 * strong enough that a human looking at the same facts would reach the same
 * conclusion every time.
 *
 * The evidence that makes this tractable is that Saudi registration series
 * are reserved per carrier and assigned before flight test. A HZ-RX_ _
 * registration on a 787 airborne out of Charleston is not a coincidence that
 * needs confirming; it is a Riyadh Air aircraft on a test flight. There is no
 * competing explanation.
 *
 * The dangerous case is the mirror image: a HZ-A__ A320 over Jeddah is
 * overwhelmingly likely to be one of the hundreds of Saudia aircraft already
 * in service, which have no place in a delivery tracker. Everything below
 * exists to separate those two situations.
 *
 * DECISIONS
 *   BIND   — claim a slot now
 *   HOLD   — plausible, not yet proven; stays a candidate, re-assessed later
 *   REJECT — actively believed not to be an outstanding delivery
 *
 * Every BIND is written with its evidence to identity_bind, and every bind is
 * reversible. Automatic does not mean unaccountable.
 */

import { OPERATORS, operatorOfReg } from "../config/operators.js";
import { SITES } from "../config/sites.js";
import { FLEET_TYPES, CALLSIGNS } from "../config/watchlist.js";

/** Evidence thresholds. Deliberately conservative: the cost of waiting an
 *  extra ten minutes is nil, the cost of a wrong bind is a corrupted history. */
export const MIN_SIGHTINGS = Number(process.env.BIND_MIN_SIGHTINGS ?? 3);
export const MIN_SPAN_MS = Number(process.env.BIND_MIN_SPAN_MS ?? 10 * 60_000);

/** A site where aircraft are built, tested, painted or handed over. A Saudi
 *  registration appearing at one of these is a new-build, full stop. */
export function isFactorySite(icao) {
  const roles = SITES[icao]?.roles ?? [];
  return roles.includes("ASSEMBLY") || roles.includes("DELIVERY_ORIGIN")
      || roles.includes("PAINT");
}

/** A Saudi airport the carriers fly into every day. Sightings here prove
 *  nothing on their own — most traffic is the existing fleet. */
export function isHomeSite(icao) {
  const roles = SITES[icao]?.roles ?? [];
  return roles.includes("DELIVERY_DEST") || roles.includes("BASE");
}

/** Is this aircraft flying under a manufacturer's callsign? That is a test or
 *  delivery flight, and it means the aircraft has not entered service. */
export function isManufacturerCallsign(flight) {
  const cs = (flight ?? "").trim().toUpperCase();
  if (!cs) return false;
  return CALLSIGNS.BOEING_TEST.test(cs) || CALLSIGNS.AIRBUS_TEST.test(cs);
}

/** Is it flying a revenue callsign for one of our carriers? That means it is
 *  already in service — which for a delivery tracker means it is not ours to
 *  track, unless we were already tracking it through its handover. */
export function isRevenueCallsign(flight) {
  const cs = (flight ?? "").trim().toUpperCase();
  if (!cs) return false;
  return Object.values(OPERATORS).some((o) => o.callsign.test(cs));
}

/** Does this operator actually have this type on order? A HZ-N registration
 *  on a 787 is either a misdecode or something we do not understand; either
 *  way it must not claim an A320neo slot. */
export function operatorOrdersType(operatorId, icaoType) {
  const op = OPERATORS[operatorId];
  if (!op) return false;
  return op.orders.some((o) => o.icao_type === icaoType && o.qty_firm > 0);
}

/**
 * The whole decision, as a pure function. Everything it needs is passed in,
 * so it is exhaustively testable without a database or a network.
 *
 * @param {object}  blip       one ADS-B fix: { hex, reg, t, flight, ts }
 * @param {object}  place      { icao } resolved geofence
 * @param {object}  candidate  accumulated sighting record, or null on first
 *                             contact: { sightings, first_seen, seen_factory }
 * @param {object}  world      { regTaken, slotAvailable } — DB facts
 */
export function assess({ blip, place, candidate, world }) {
  const reg = (blip.reg ?? "").trim().toUpperCase();
  const at = place?.icao;
  const type = blip.t;

  if (!reg) {
    return { decision: "HOLD", reason: "no registration in the feed yet" };
  }

  const operator = operatorOfReg(reg);
  if (!operator) {
    return { decision: "REJECT", reason: `${reg} is not a tracked carrier's series` };
  }

  if (!FLEET_TYPES[type]) {
    return { decision: "REJECT", reason: `${type} is not an ordered type` };
  }

  if (world.regTaken) {
    return { decision: "REJECT", reason: `${reg} is already bound to another airframe` };
  }

  // --- the in-service filter ---
  //
  // This runs BEFORE any question about order slots, and the ordering is the
  // whole point. An in-service Saudia A320 is precisely a frame the order
  // book has no slot for, so testing slots first sends the most dangerous
  // input straight down the overflow path and mints a new airframe row for an
  // aircraft delivered years ago. Ask "is this a new-build?" first; ask
  // "where does it go?" only once the answer is yes.

  if (isRevenueCallsign(blip.flight) && !candidate?.seen_factory) {
    return {
      decision: "REJECT",
      reason: `${blip.flight} is a revenue callsign and this frame has never been ` +
              `seen at a factory — it is an in-service aircraft, not a delivery`,
    };
  }

  if (at && isHomeSite(at) && !isFactorySite(at) && !candidate?.seen_factory
      && !isManufacturerCallsign(blip.flight)) {
    return {
      decision: "HOLD",
      reason: `seen only at ${at}, which the existing fleet uses daily; ` +
              `waiting for a factory sighting or a delivery-ferry callsign`,
    };
  }

  // --- now, and only now, where does it belong? ---

  if (!operatorOrdersType(operator, type)) {
    // Saudia's 787 backlog is real but unpublished, so it is seeded at zero
    // and has no slots. Refusing here would make the app permanently blind to
    // exactly the deliveries it most wants to catch, so an overflow bind
    // creates the row instead of claiming one. Reachable only for aircraft
    // that already passed the new-build tests above.
    if (world.overflowAllowed) {
      return gate(candidate, {
        decision: "BIND", overflow: true, operator, reg, type,
        reason: `${operator} has no seeded ${type} slots; creating one from observation`,
        confidence: 0.85,
      });
    }
    return { decision: "REJECT", reason: `${operator} has no ${type} on order` };
  }

  // --- positive evidence ---

  if (at && isFactorySite(at)) {
    return gate(candidate, {
      decision: "BIND", operator, reg, type,
      reason: `${reg} at ${at}, which builds and hands over ${type}`,
      confidence: 0.97,
    });
  }

  if (isManufacturerCallsign(blip.flight)) {
    return gate(candidate, {
      decision: "BIND", operator, reg, type,
      reason: `${reg} flying as ${blip.flight}, a manufacturer callsign`,
      confidence: 0.95,
    });
  }

  if (candidate?.seen_factory) {
    return gate(candidate, {
      decision: "BIND", operator, reg, type,
      reason: `${reg} previously seen at a factory site, now at ${at ?? "unknown"}`,
      confidence: 0.93,
    });
  }

  return { decision: "HOLD", reason: "no factory contact and no test callsign yet" };
}

/**
 * A single decode can be garbled — a corrupted registration field, a stale
 * cache in a feeder. Requiring repeated sightings over a span of time costs
 * nothing and removes that whole class of error.
 */
function gate(candidate, verdict) {
  const n = candidate?.sightings ?? 1;
  const span = candidate?.first_seen
    ? Date.now() - new Date(candidate.first_seen).getTime()
    : 0;

  if (n < MIN_SIGHTINGS) {
    return {
      decision: "HOLD",
      reason: `${verdict.reason} — ${n} of ${MIN_SIGHTINGS} sightings so far`,
      pending: verdict,
    };
  }
  if (span < MIN_SPAN_MS) {
    return {
      decision: "HOLD",
      reason: `${verdict.reason} — seen for ${Math.round(span / 60000)} min, ` +
              `need ${Math.round(MIN_SPAN_MS / 60000)}`,
      pending: verdict,
    };
  }
  return verdict;
}

/**
 * Which projected row should a confirmed registration claim?
 *
 * Lowest sequence number first, so bindings are deterministic and replaying
 * the same sightings produces the same assignment. The slot is a placeholder
 * for "the Nth A321neo flynas will receive" — it carries no identity of its
 * own, so which one we pick has no consequence beyond the row's id.
 */
export function chooseSlot(slots) {
  if (!slots?.length) return null;
  return [...slots].sort((a, b) => {
    const na = Number(String(a.id).split("-").pop());
    const nb = Number(String(b.id).split("-").pop());
    return na - nb;
  })[0];
}
