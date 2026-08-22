import { inferInService } from "../lib/infer.js";
let pass=0, fail=0;
const ok=(n,c,e="")=>{ c?(pass++,console.log(`  ok   ${n}`)):(fail++,console.log(`  FAIL ${n} ${e}`)); };
console.log("\nin-service inference\n");

let v = inferInService({ flight: "RXI311" }, { currentStage: "FIRST" });
ok("an aircraft stuck at FIRST still enters service on a revenue callsign",
   v?.stage === "SERVICE", JSON.stringify(v));
ok("  and flags that the handover was never observed", v?.backfillDelivery === true);

v = inferInService({ flight: "RXI311" }, { currentStage: "DELIVERY" });
ok("a normally-tracked handover needs no backfill", v?.backfillDelivery === false);

v = inferInService({ flight: "SVA1023" }, { currentStage: "FIRST" });
ok("Saudia callsigns enter service too", v?.stage === "SERVICE", JSON.stringify(v));
v = inferInService({ flight: "NAS551" }, { currentStage: "DELIVERY" });
ok("flynas callsigns enter service too", v?.stage === "SERVICE");
v = inferInService({ flight: "FAD120" }, { currentStage: "DELIVERY" });
ok("flyadeal callsigns enter service too", v?.stage === "SERVICE");

v = inferInService({ flight: "RXI9901" }, { currentStage: "DELIVERY" });
ok("the delivery ferry callsign RXI9901 is NOT entry into service",
   v === null, JSON.stringify(v));
v = inferInService({ flight: "SVA9912" }, { currentStage: "DELIVERY" });
ok("ferry block is excluded for every carrier", v === null, JSON.stringify(v));
v = inferInService({ flight: "RXI401" }, { currentStage: "DELIVERY" });
ok("a scheduled route number still enters service", v?.stage === "SERVICE");

v = inferInService({ flight: "BOE047" }, { currentStage: "FIRST" });
ok("a Boeing test callsign never means in service", v === null, JSON.stringify(v));
v = inferInService({ flight: "RXI311" }, { currentStage: "SERVICE" });
ok("already in service is not re-reported", v === null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
