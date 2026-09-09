export const handedOver = f => ["DELIVERY", "SERVICE"].includes(f.current_stage);
export const isTrackedOrder = f => f.tracking_kind !== "lease" && !f.id?.startsWith("leased-");
export function countsFor(roster, operator) {
  const c = { ordered: 0, production: 0, test: 0, delivered: 0 };
  for (const f of roster.filter(f => isTrackedOrder(f) && f.operator === operator && f.identity_source !== "projected")) {
    if (handedOver(f)) c.delivered++;
    else if (f.current_stage === "ORDERED") c.ordered++;
    else if (["SLOT","ASSEMBLY","ROLLOUT","GROUND"].includes(f.current_stage)) c.production++;
    else if (["FIRST","PAINT","CUSTOMER"].includes(f.current_stage)) c.test++;
  }
  return c;
}
export function feedStatus(connection, health, now = Date.now()) {
  if (connection !== "connected") return connection;
  if (!health) return "checking feeds";
  if (health.ingest === "disabled") return "tracking off";
  const feeds = Object.values(health.feeds ?? {});
  if (!feeds.length) return "waiting for feeds";
  const fresh = feeds.filter(f => f.ok && now - f.at < 120000);
  if (!fresh.length) return "feeds unavailable";
  return fresh.length === feeds.length ? "live" : "partial coverage";
}
export function safeStageLabel(mfr, key, stages, index, names) {
  if (key === "IDENTIFIED") return "Aircraft identified";
  return names[mfr]?.[key] ?? stages[index[key]]?.label ?? "Unrecognized event";
}
