import crypto from "node:crypto";

/**
 * The whole point of this file: a 787 doing four circuits over South
 * Carolina must produce ONE first-flight event, not four.
 *
 * Three independent guards, because each catches a different failure:
 *   1. Idempotency  — one event per (airframe, stage), ever.
 *   2. Monotonicity — stages never move backwards, even if a stale poll
 *                     arrives out of order.
 *   3. Cooldown     — a per-airframe write lock, so two workers racing on
 *                     the same tick cannot both win.
 */

const KEY = {
  stage: (airframeId, stage) =>
    `stage:${crypto.createHash("sha1").update(`${airframeId}:${stage}`).digest("hex")}`,
  current: (airframeId) => `cur:${airframeId}`,
  lock: (airframeId) => `lock:${airframeId}`,
  sortie: (hex) => `sortie:${hex}`,
  seen: (hex) => `seen:${hex}`,
};

export class Dedup {
  /** @param redis ioredis-compatible client */
  constructor(redis, stageIndex) {
    this.r = redis;
    this.idx = stageIndex; // { ORDERED: 0, SLOT: 1, ... }
  }

  /**
   * Returns true exactly once per airframe+stage, and only when the stage
   * is strictly ahead of what we already recorded.
   */
  async claim(airframeId, stage, ts) {
    const lock = await this.r.set(KEY.lock(airframeId), "1", "NX", "PX", 5000);
    if (!lock) return false;

    try {
      const cur = await this.r.get(KEY.current(airframeId));
      const curIdx = cur === null ? -1 : this.idx[cur];
      const newIdx = this.idx[stage];

      if (newIdx === undefined) return false;
      if (newIdx <= curIdx) return false; // regression or repeat

      const first = await this.r.set(KEY.stage(airframeId, stage), String(ts), "NX");
      if (!first) return false;

      await this.r.set(KEY.current(airframeId), stage);
      return true;
    } finally {
      await this.r.del(KEY.lock(airframeId));
    }
  }

  /** Has this hex ever been seen airborne before? First 'no' is a first flight. */
  async firstEverAirborne(hex, ts) {
    return (await this.r.set(KEY.seen(hex), String(ts), "NX")) !== null;
  }

  /* ---- sortie assembly: many fixes -> one flight ---- */

  async openSortie(hex, { departed, ts }) {
    const existing = await this.r.get(KEY.sortie(hex));
    if (existing) return JSON.parse(existing);
    const s = { hex, departed, startedAt: ts, lastSeen: ts, maxAlt: 0, arrived: null };
    await this.r.set(KEY.sortie(hex), JSON.stringify(s), "EX", 86400);
    return s;
  }

  async touchSortie(hex, patch) {
    const raw = await this.r.get(KEY.sortie(hex));
    if (!raw) return null;
    const s = { ...JSON.parse(raw), ...patch };
    await this.r.set(KEY.sortie(hex), JSON.stringify(s), "EX", 86400);
    return s;
  }

  /** Close only after sustained ground time — a touch-and-go is not a landing. */
  async closeSortie(hex, ts, groundHoldMs = 10 * 60 * 1000) {
    const raw = await this.r.get(KEY.sortie(hex));
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (ts - s.lastSeen < groundHoldMs) return null;
    await this.r.del(KEY.sortie(hex));
    return { ...s, endedAt: ts };
  }
}
