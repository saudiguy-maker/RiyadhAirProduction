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

/** Which site is this fix inside? Returns { icao, onRamp } or null. */
export function locate(lat, lon) {
  for (const s of Object.values(SITES)) {
    const d = haversineKm(lat, lon, s.circle.lat, s.circle.lon);
    if (d > s.circle.radius_km) continue;
    const onRamp = s.ramp ? pointInPolygon(lat, lon, s.ramp) : false;
    return { icao: s.icao, onRamp, distance_km: Number(d.toFixed(2)) };
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
