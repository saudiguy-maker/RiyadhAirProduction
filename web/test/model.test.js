import test from "node:test";
import assert from "node:assert/strict";
import { countsFor, feedStatus, safeStageLabel } from "../src/model.js";
test("delivery and service count as handovers; observed aircraft count and leases do not", () => {
  const rows = ["DELIVERY","SERVICE","FIRST","ORDERED"].map((current_stage,i) => ({id: String(i),operator: "SVA", current_stage, identity_source: "observed", order_line_id: null}));
  rows.push({id: "leased-X",operator:"SVA",current_stage:"SERVICE",identity_source:"verified"});
  rows.push({id: "placeholder",operator:"SVA",current_stage:"ORDERED",identity_source:"projected"});
  assert.deepEqual(countsFor(rows,"SVA"), {ordered:1,production:0,test:1,delivered:2});
});
test("identification and unknown event kinds have safe labels", () => {
  assert.equal(safeStageLabel("BOEING","IDENTIFIED",[],{},{}), "Aircraft identified");
  assert.equal(safeStageLabel("BOEING","NEW_STAGE",[],{},{}), "Unrecognized event");
});
test("open socket is not sufficient for live status", () => {
  assert.equal(feedStatus("connected", null), "checking feeds");
  assert.equal(feedStatus("connected", {ingest:"disabled"}), "tracking off");
  assert.equal(feedStatus("connected", {feeds:{a:{ok:true,at:0}}}, 200000), "feeds unavailable");
  assert.equal(feedStatus("connected", {feeds:{a:{ok:true,at:200000},b:{ok:false,at:200000}}}, 200000), "partial coverage");
});
