/**
 * Feed adapters. All three return the same normalised blip shape, so the
 * worker never knows which one is answering.
 *
 *   airplanes.live  free, community, ~1 req/sec, no key
 *   adsb.fi         free, community, no key — use as the failover
 *   ADSB Exchange   paid via RapidAPI, best coverage over Charleston
 *
 * Run two providers concurrently and union the results. Community networks
 * have gaps exactly where you care: Charleston is well covered, Toulouse is
 * good, Hamburg-Finkenwerder is patchy at low altitude.
 */

const UA = "riyadh-air-delivery-watch/1.0";

/**
 * adsb.lol — free, no key, and unlike airplanes.live it does not block
 * datacentre IP ranges. That distinction is invisible in development and
 * decisive in production: airplanes.live answers a laptop happily and
 * returns 403 to every request from Railway, so the feed this app was built
 * around could never work where the app actually runs.
 */
export class AdsbLol {
  constructor() { this.name = "adsb.lol"; this.rl = new RateLimiter(1); }
  async near(lat, lon, radiusNm) {
    await this.rl.wait();
    const r = Math.min(250, Math.round(radiusNm));
    const j = await getJSON(`https://api.adsb.lol/v2/point/${lat}/${lon}/${r}`);
    return (j.ac ?? []).map(normalise);
  }
  async byHex(hex) {
    await this.rl.wait();
    const j = await getJSON(`https://api.adsb.lol/v2/hex/${hex.toLowerCase()}`);
    return (j.ac ?? []).map(normalise);
  }
}

class RateLimiter {
  constructor(perSecond) { this.gap = 1000 / perSecond; this.next = 0; }
  async wait() {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.gap;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

export async function getJSON(url, { retries = 1, headers = {}, timeoutMs = 8000 } = {}) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status}`);
        e.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
        throw e;
      }
      return await res.json();
    } catch (err) {
      if (err.permanent || i >= retries) throw err;
      await new Promise(r => setTimeout(r, 800 * 2 ** i));
    }
  }
}

/** Position age, not request time, determines which observation is newest. */
export const normalise = (a) => {
  const age = Number(a.seen_pos ?? a.seen ?? 0);
  return {
    hex: String(a.hex ?? a.icao ?? "").toUpperCase(),
    reg: (a.r ?? a.reg)?.trim().toUpperCase() || null,
    t: (a.t ?? a.type)?.trim().toUpperCase() || null,
    flight: (a.flight ?? "").trim().toUpperCase() || null,
    lat: a.lat, lon: a.lon, alt_baro: a.alt_baro, alt_geom: a.alt_geom,
    gs: a.gs, track: a.track, seen: age,
    ts: Date.now() - age * 1000,
  };
};

export class AirplanesLive {
  constructor() { this.name = "airplanes.live"; this.rl = new RateLimiter(1); }
  async near(lat, lon, radiusNm) {
    await this.rl.wait();
    const r = Math.min(250, Math.round(radiusNm));
    const url = `https://api.airplanes.live/v2/point/${lat}/${lon}/${r}`;
    const j = await getJSON(url);
    return (j.ac ?? []).map(normalise);
  }
  async byHex(hex) {
    await this.rl.wait();
    const j = await getJSON(`https://api.airplanes.live/v2/hex/${hex.toLowerCase()}`);
    return (j.ac ?? []).map(normalise);
  }
}

export class AdsbFi {
  constructor() { this.name = "adsb.fi"; this.rl = new RateLimiter(1); }
  async near(lat, lon, radiusNm) {
    await this.rl.wait();
    const r = Math.min(250, Math.round(radiusNm));
    const j = await getJSON(`https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${r}`);
    return (j.aircraft ?? j.ac ?? []).map(normalise);
  }
}

export class AdsbExchange {
  constructor(key) { this.name = "adsbexchange"; this.key = key; this.rl = new RateLimiter(2); }
  async near(lat, lon, radiusNm) {
    if (!this.key) return [];
    await this.rl.wait();
    const url = `https://adsbexchange-com1.p.rapidapi.com/v2/lat/${lat}/lon/${lon}/dist/${Math.round(radiusNm)}/`;
    const j = await getJSON(url, { headers: {
      "X-RapidAPI-Key": this.key,
      "X-RapidAPI-Host": "adsbexchange-com1.p.rapidapi.com",
    } });
    return (j.ac ?? []).map(normalise);
  }
}

/**
 * Union results from every healthy provider, newest fix per hex wins.
 *
 * A provider that is refusing us is not merely useless, it is expensive: it
 * holds a slot in the rate limiter and burns retry backoff on every sweep,
 * slowing the polls that DO work until they miss the aircraft they exist to
 * catch. A repeatedly failing provider is therefore benched rather than
 * politely retried forever.
 */
export class ProviderPool {
  constructor(providers, { failuresBeforeBench = 3, benchMs = 10 * 60_000 } = {}) {
    this.providers = providers;
    this.health = new Map();
    this.strikes = new Map();
    this.benched = new Map();
    this.failuresBeforeBench = failuresBeforeBench;
    this.benchMs = benchMs;
  }

  active() {
    const now = Date.now();
    return this.providers.filter((p) => {
      const until = this.benched.get(p.name);
      if (until && now < until) return false;
      if (until) { this.benched.delete(p.name); this.strikes.set(p.name, 0); }
      return true;
    });
  }

  /** Ask every provider once and report who answers. Run at startup so a
   *  blocked feed is loud on day one instead of silent for a fortnight. */
  async probe(lat = 32.8986, lon = -80.0405, radiusNm = 50) {
    const out = [];
    for (const p of this.providers) {
      try {
        const ac = await p.near(lat, lon, radiusNm);
        out.push({ provider: p.name, ok: true, aircraft: ac.length });
      } catch (err) {
        out.push({ provider: p.name, ok: false, error: err.message });
      }
    }
    return out;
  }

  async near(lat, lon, radiusNm) {
    const providers = this.active();
    if (!providers.length) {
      throw new Error("every ADS-B provider is benched — no feed is reachable");
    }
    const settled = await Promise.allSettled(
      providers.map((p) => p.near(lat, lon, radiusNm)),
    );
    const merged = new Map();
    settled.forEach((s, i) => {
      const p = providers[i];
      if (s.status === "rejected") {
        const n = (this.strikes.get(p.name) ?? 0) + 1;
        this.strikes.set(p.name, n);
        this.health.set(p.name, { ok: false, err: s.reason?.message, at: Date.now(), strikes: n });
        if (n >= this.failuresBeforeBench) {
          this.benched.set(p.name, Date.now() + this.benchMs);
          console.warn(`[providers] benching ${p.name} for ` +
                       `${Math.round(this.benchMs / 60000)} min: ${s.reason?.message}`);
        }
        return;
      }
      this.strikes.set(p.name, 0);
      this.health.set(p.name, { ok: true, at: Date.now(), count: s.value.length });
      for (const b of s.value) {
        if (!/^[0-9A-F]{6}$/.test(b.hex ?? "") ||
            !Number.isFinite(b.lat) || !Number.isFinite(b.lon) ||
            Math.abs(b.lat) > 90 || Math.abs(b.lon) > 180 ||
            !Number.isFinite(b.seen ?? 0) || (b.seen ?? 0) < 0 || (b.seen ?? 0) > 60) continue;
        const prev = merged.get(b.hex);
        if (!prev || (b.seen ?? 99) < (prev.seen ?? 99)) merged.set(b.hex, { ...b, provider: p.name });
      }
    });
    return [...merged.values()];
  }
}

