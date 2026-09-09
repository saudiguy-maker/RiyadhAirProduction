import { SITES, siteRoles } from "../config/sites.js";
import { CALLSIGNS, FLEET_TYPES, inFlightTest } from "../config/watchlist.js";
import { operatorOfCallsign, isFerryCallsign } from "../config/operators.js";

/**
 * Rules that turn flights into milestones. Each returns null or
 * { stage, confidence, why }. Confidence matters: ADS-B alone cannot
 * distinguish a customer acceptance flight from a late production test,
 * so anything below 0.8 is written as a provisional event and reconciled
 * against the monthly manufacturer tables rather than pushed as an alert.
 */

const HOURS = 3600_000;

export const STAGE_ORDER = [
  "ORDERED", "SLOT", "ASSEMBLY", "ROLLOUT", "GROUND",
  "FIRST", "PAINT", "CUSTOMER", "DELIVERY", "SERVICE",
];
export const STAGE_INDEX = Object.fromEntries(STAGE_ORDER.map((s, i) => [s, i]));

/** Ground movement on a factory ramp, no flight yet. */
export function inferGround(blip, place) {
  if (!place?.onRamp) return null;
  if (!siteRoles(place.icao, "GROUND")) return null;
  const gs = Number(blip.gs ?? 0);
  if (gs < 3) return { stage: "ROLLOUT", confidence: 0.6, why: "transponder live on factory ramp" };
  return { stage: "GROUND", confidence: 0.7, why: `taxi test at ${place.icao}` };
}

/**
 * First time this airframe has ever left the ground.
 *
 * Fires on a LIVE fix, not on a closed sortie — waiting for the aircraft to
 * land would cost three hours on the one event people most want instantly.
 * The trade is that we take the geofence the aircraft is currently in as the
 * departure field, which is safe: a first flight does not begin somewhere
 * other than where the airframe was built.
 */
export function inferFirstFlight({ place, sortie, ctx }) {
  if (!ctx.neverSeenBefore || STAGE_INDEX[ctx.currentStage] >= STAGE_INDEX.FIRST) return null;
  if (!sortie && !ctx.airborne) return null;
  const departed = sortie?.departed ?? place?.icao;
  if (!departed || !siteRoles(departed, "FIRST")) return null;
  return {
    stage: "FIRST",
    confidence: 0.65,
    why: `first observed airborne contact over ${departed}; first flight date unconfirmed`,
  };
}

/** A one-way hop from the assembly field to a paint site. */
export function inferPaint(sortie) {
  if (!sortie.arrived || sortie.arrived === sortie.departed) return null;
  if (!siteRoles(sortie.departed, "ASSEMBLY")) return null;
  if (!siteRoles(sortie.arrived, "PAINT")) return null;
  return { stage: "PAINT", confidence: 0.85, why: `ferried ${sortie.departed} → ${sortie.arrived}` };
}

/**
 * Customer acceptance: a there-and-back sortie from the delivery field,
 * two to five hours, flown after paint. Production test flights look
 * similar, which is why this stays provisional.
 */
export function inferCustomerFlight(sortie, { currentStage }) {
  if (currentStage !== "PAINT") return null;
  if (sortie.arrived !== sortie.departed) return null;
  if (!siteRoles(sortie.departed, "CUSTOMER")) return null;
  const dur = sortie.endedAt - sortie.startedAt;
  if (dur < 2 * HOURS || dur > 5 * HOURS) return null;
  return {
    stage: "CUSTOMER",
    confidence: 0.75,
    why: `${(dur / HOURS).toFixed(1)}h round trip from ${sortie.departed} after paint`,
  };
}

/**
 * One-way, factory to a Saudi base. The unmistakable one.
 *
 * Note the destination is any DELIVERY_DEST, not Riyadh specifically:
 * HZ-RXAD, RXAE and RXAF were all delivered to Jeddah. Hard-coding OERK
 * would have silently missed half the deliveries to date.
 */
export function inferDelivery(sortie, ctx = {}) {
  if (!siteRoles(sortie.departed, "DELIVERY_ORIGIN")) return null;
  if (!siteRoles(sortie.arrived ?? "", "DELIVERY_DEST")) return null;
  // A manufacturer callsign on the way to Saudi is a ferry, not a handover.
  if (inFlightTest(sortie.callsign)) return null;
  return {
    stage: "DELIVERY",
    confidence: 0.98,
    why: `delivery flight ${sortie.departed} → ${sortie.arrived}`,
  };
}

/**
 * First revenue callsign. The airframe stops being a product.
 *
 * Two things this deliberately does NOT do.
 *
 * It does not require the airframe to have reached DELIVERY first. That
 * precondition looks like sound bookkeeping and is in fact a trap: an
 * aircraft handed over before this system was watching sits at whatever
 * stage it was last seen in, and a rule gated on DELIVERY can never move it,
 * however many revenue flights it operates. The app would go on insisting a
 * flying airliner was in flight test forever. A revenue callsign is direct
 * evidence of service and is treated as such, whatever we previously
 * believed. Where the DELIVERY rung is missing, it is backfilled — with an
 * unknown date, honestly marked, rather than a guessed one.
 *
 * It does not test one carrier's callsign. RIYADH_AIR was correct when the
 * roster held one airline; with four it silently prevented Saudia, flynas
 * and flyadeal frames from ever entering service.
 */
export function inferInService(blip, { currentStage }) {
  const cs = (blip.flight ?? "").trim().toUpperCase();
  const operator = operatorOfCallsign(cs);
  if (!operator) return null;
  if (currentStage === "SERVICE") return null;
  // The delivery ferry wears the carrier's own callsign. It is the last
  // flight of the handover, not the first of the airline's service.
  if (isFerryCallsign(cs)) return null;

  const missedHandover = STAGE_INDEX[currentStage] < STAGE_INDEX.DELIVERY;
  return {
    stage: "SERVICE",
    confidence: missedHandover ? 0.85 : 0.9,
    backfillDelivery: missedHandover,
    why: missedHandover
      ? `operating as ${cs}; handover happened before this system saw it, ` +
        `delivery date remains unknown`
      : `operating as ${cs}`,
  };
}

/**
 * Runs every rule and returns the furthest-along match. Order matters less
 * than you would think — the dedup layer rejects regressions anyway — but
 * taking the highest index avoids emitting PAINT and DELIVERY on the same
 * tick when a frame has been off coverage for a week.
 */
export function inferAll({ blip, place, sortie, ctx }) {
  const out = [inferFirstFlight({ place, sortie, ctx })];
  if (blip && place) out.push(inferGround(blip, place), inferInService(blip, ctx));
  if (sortie) {
    out.push(inferPaint(sortie), inferCustomerFlight(sortie, ctx), inferDelivery(sortie, ctx));
  }
  const hits = out.filter(Boolean);
  if (!hits.length) return null;
  return hits.sort((a, b) => STAGE_INDEX[b.stage] - STAGE_INDEX[a.stage])[0];
}

export const typeOf = (blip) => FLEET_TYPES[blip.t] ?? null;
export const siteName = (icao) => SITES[icao]?.name ?? icao;

