import { SITES } from "../config/sites.js";

const R = 6371;
const rad = (d) => (d * Math.PI) / 180;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Ray casting. Ring is [[lat,lon],...]; closure is implicit. */
export function pointInPolygon(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    const intersects =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Ceiling above which an aircraft inside a site's circle is merely passing
 * over it, not visiting it.
 *
 * A geofence with no altitude limit is a column reaching into space. Hamburg
 * -Finkenwerder sits under some of the busiest airspace in Europe, so a 10 km
 * circle with no ceiling captures every airliner crossing northern Germany at
 * cruise and files them all as present at the Airbus factory. That is how an
 * in-service Saudia 787 came to be logged at Finkenwerder, which in turn set
 * the flag that disarms the in-service filter and let it be bound as an
 * undelivered aircraft.
 *
 * 8,000 ft is comfortably above a circuit, an approach or a low test pass,
 * and far below any cruising traffic.
 */
export const SITE_CEILING_FT = Number(process.env.SITE_CEILING_FT ?? 8000);

/** Altitude in feet, or null when the feed does not say. */
export function altitudeFt(blip) {
  if (!blip) return null;
  if (blip.alt_baro === "ground") return 0;
  const alt = blip.alt_baro ?? blip.alt_geom;
  return alt == null ? null : Number(alt);
}

/**
 * Which site is this fix inside? Returns { icao, onRamp } or null.
 *
 * Pass the whole blip rather than bare coordinates to get the altitude test.
 * The (lat, lon) form is kept working so existing callers and tests do not
 * break, but it cannot tell a visitor from an overflight.
 */
export function locate(latOrBlip, lon, opts = {}) {
  const blip = typeof latOrBlip === "object" && latOrBlip !== null ? latOrBlip : null;
  const lat = blip ? blip.lat : latOrBlip;
  const lng = blip ? blip.lon : lon;
  if (lat == null || lng == null) return null;

  const ceiling = opts.ceilingFt ?? SITE_CEILING_FT;
  const alt = blip ? altitudeFt(blip) : opts.altitudeFt ?? null;

  for (const s of Object.values(SITES)) {
    const d = haversineKm(lat, lng, s.circle.lat, s.circle.lon);
    if (d > s.circle.radius_km) continue;

    // Unknown altitude is not treated as disqualifying: some feeders drop the
    // field, and discarding those fixes would lose real ramp movements. It is
    // reported instead, so callers that care can weigh it.
    const overflight = alt != null && alt > ceiling;
    if (overflight) return null;

    const onRamp = s.ramp ? pointInPolygon(lat, lng, s.ramp) : false;
    return {
      icao: s.icao,
      onRamp,
      distance_km: Number(d.toFixed(2)),
      altitude_ft: alt,
      altitude_known: alt != null,
    };
  }
  return null;
}

/** Airborne test: ADS-B ground flag is authoritative when present, but
 *  aggregators sometimes drop it. Fall back to altitude + groundspeed. */
export function isAirborne(blip) {
  if (blip.alt_baro === "ground") return false;
  const alt = Number(blip.alt_baro ?? blip.alt_geom ?? 0);
  const gs = Number(blip.gs ?? 0);
  return alt > 500 || gs > 80;
}
