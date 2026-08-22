/**
 * Geofences for every site an airframe touches between final assembly
 * and revenue service.
 *
 * Two shapes are used:
 *   circle  — centre + radius_km. Cheap, good for "is it flying near here".
 *   polygon — [ [lat,lon], ... ] closed ring. Used for ramps where a circle
 *             would swallow a neighbouring terminal and produce false hits.
 *
 * VERIFY BEFORE PRODUCTION: ramp polygons drift as manufacturers re-stripe
 * apron areas. Pull current outlines from OpenStreetMap (aeroway=apron) and
 * re-cut them once, then treat this file as data, not code.
 */

export const SITES = {
  // ---------- Boeing ----------
  KCHS: {
    icao: "KCHS",
    name: "Charleston Intl / Boeing South Carolina",
    manufacturer: "BOEING",
    roles: ["ASSEMBLY", "ROLLOUT", "GROUND", "FIRST", "PAINT", "CUSTOMER", "DELIVERY_ORIGIN"],
    types: ["B789", "B78X"],
    circle: { lat: 32.8986, lon: -80.0405, radius_km: 12 },
    // Boeing delivery centre apron, east side of the field.
    ramp: [
      [32.8862, -80.0295],
      [32.8862, -80.0180],
      [32.8770, -80.0180],
      [32.8770, -80.0295],
    ],
  },
  KPAE: {
    icao: "KPAE",
    name: "Paine Field / Everett",
    manufacturer: "BOEING",
    roles: ["FIRST", "GROUND", "STORAGE", "DELIVERY_ORIGIN"],
    types: ["B789", "B78X"],
    circle: { lat: 47.9063, lon: -122.2816, radius_km: 12 },
  },

  // ---------- Airbus ----------
  LFBO: {
    icao: "LFBO",
    name: "Toulouse-Blagnac",
    manufacturer: "AIRBUS",
    roles: ["ASSEMBLY", "ROLLOUT", "GROUND", "FIRST", "PAINT", "CUSTOMER", "DELIVERY_ORIGIN"],
    types: ["A35K", "A21N", "A20N", "A339"],
    circle: { lat: 43.6293, lon: 1.3638, radius_km: 12 },
    ramp: [
      [43.6210, 1.3560],
      [43.6210, 1.3760],
      [43.6120, 1.3760],
      [43.6120, 1.3560],
    ],
  },
  EDHI: {
    icao: "EDHI",
    name: "Hamburg-Finkenwerder",
    manufacturer: "AIRBUS",
    roles: ["ASSEMBLY", "ROLLOUT", "GROUND", "FIRST", "PAINT", "CUSTOMER", "DELIVERY_ORIGIN"],
    types: ["A21N", "A20N"],
    circle: { lat: 53.5353, lon: 9.8358, radius_km: 10 },
  },
  LFBD: {
    icao: "LFBD",
    name: "Bordeaux-Mérignac",
    manufacturer: "AIRBUS",
    roles: ["PAINT"],
    types: ["A35K", "A21N", "A20N", "A339"],
    circle: { lat: 44.8283, lon: -0.7156, radius_km: 10 },
  },

  // ---------- Destination ----------
  OERK: {
    icao: "OERK",
    name: "King Khalid Intl, Riyadh",
    manufacturer: null,
    roles: ["DELIVERY_DEST", "BASE"],
    types: ["B789", "B78X", "A35K", "A21N", "A20N", "A339"],
    circle: { lat: 24.9576, lon: 46.6988, radius_km: 25 },
    pollEvery: 3,
  },
  OEJN: {
    icao: "OEJN",
    name: "King Abdulaziz Intl, Jeddah",
    manufacturer: null,
    // NOT just a base. HZ-RXAD, RXAE and RXAF were all delivered straight
    // to Jeddah rather than Riyadh. Without DELIVERY_DEST here, half of
    // the deliveries to date would never have fired an event.
    roles: ["DELIVERY_DEST", "BASE"],
    types: ["B789", "B78X", "A35K", "A21N", "A20N", "A339"],
    circle: { lat: 21.6796, lon: 39.1565, radius_km: 25 },
    pollEvery: 3,
  },

  // ---------- Airbus A320-family final assembly ----------
  // flynas and flyadeal are all-Airbus narrowbody operators, so most of
  // their airframes are born in Hamburg or Toulouse. Mobile and Tianjin
  // are included for completeness; neither has historically delivered to
  // a Saudi carrier, so they poll infrequently.
  KBFM: {
    icao: "KBFM",
    name: "Mobile Brookley / Airbus US",
    manufacturer: "AIRBUS",
    roles: ["ASSEMBLY", "ROLLOUT", "GROUND", "FIRST", "PAINT", "CUSTOMER", "DELIVERY_ORIGIN"],
    types: ["A20N", "A21N"],
    circle: { lat: 30.6268, lon: -88.0681, radius_km: 10 },
    pollEvery: 6,
  },
  ZBTJ: {
    icao: "ZBTJ",
    name: "Tianjin Binhai / Airbus China",
    manufacturer: "AIRBUS",
    roles: ["ASSEMBLY", "ROLLOUT", "GROUND", "FIRST", "PAINT", "CUSTOMER", "DELIVERY_ORIGIN"],
    types: ["A20N", "A21N"],
    circle: { lat: 39.1244, lon: 117.3462, radius_km: 12 },
    pollEvery: 6,
  },

  OEDF: {
    icao: "OEDF",
    name: "King Fahd Intl, Dammam",
    manufacturer: null,
    roles: ["DELIVERY_DEST", "BASE"],
    types: ["B789", "B78X", "A35K", "A21N", "A20N", "A339"],
    circle: { lat: 26.4712, lon: 49.7979, radius_km: 25 },
    pollEvery: 3,
  },
};

/** Sites that must be polled every tick. Riyadh is included so the
 *  delivery arrival fires from the destination end even if the aircraft
 *  drops off coverage mid-ocean. */
/**
 * Nine sites cannot all be polled every five seconds: the free feeds rate
 * limit to roughly one request a second, so a full sweep would take longer
 * than the tick and the loop would fall behind itself.
 *
 * So sites carry a pollEvery multiplier. Factories are swept every tick,
 * because first flight is the event worth having in seconds. Delivery
 * destinations are swept every third tick — a delivery flight runs six to
 * thirteen hours, and fifteen seconds of latency on arrival is invisible.
 */
export const POLLED_SITES = [
  "KCHS", "KPAE", "LFBO", "EDHI", "LFBD", "KBFM", "ZBTJ", "OERK", "OEJN", "OEDF",
];

export const shouldPoll = (icao, tickCount) =>
  tickCount % (SITES[icao]?.pollEvery ?? 1) === 0;

export const siteRoles = (icao, role) => SITES[icao]?.roles.includes(role) ?? false;
