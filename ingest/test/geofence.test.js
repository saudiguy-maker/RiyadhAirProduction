/**
 * A geofence without a ceiling is a column reaching into space. These tests
 * exist because that omission let an in-service Saudia 787, cruising over
 * northern Germany, be recorded as present at the Airbus factory — and from
 * there be bound as an undelivered aircraft.
 */
import { locate, SITE_CEILING_FT } from "../lib/geo.js";

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${e}`)); };

// Hamburg-Finkenwerder
const HAM = { lat: 53.5353, lon: 9.8358 };

console.log("\ngeofence altitude ceiling\n");

let r = locate({ ...HAM, alt_baro: 36000 });
ok("an airliner at cruise over Finkenwerder is NOT at the factory", r === null, JSON.stringify(r));

r = locate({ ...HAM, alt_baro: "ground" });
ok("an aircraft on the ground there is", r?.icao === "EDHI", JSON.stringify(r));

r = locate({ ...HAM, alt_baro: 1200 });
ok("one in the circuit is", r?.icao === "EDHI");

r = locate({ ...HAM, alt_baro: SITE_CEILING_FT + 1 });
ok("just above the ceiling is not", r === null);

r = locate({ ...HAM, alt_baro: SITE_CEILING_FT - 1 });
ok("just below it is", r?.icao === "EDHI");

r = locate({ ...HAM });
ok("unknown altitude is kept rather than discarded", r?.icao === "EDHI", JSON.stringify(r));
ok("  but flagged as unverified", r?.altitude_known === false);

r = locate({ lat: 0, lon: 0, alt_baro: 100 });
ok("open ocean is no site", r === null);

r = locate(HAM.lat, HAM.lon);
ok("the old two-argument form still resolves", r?.icao === "EDHI");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
