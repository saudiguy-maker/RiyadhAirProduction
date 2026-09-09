import express from "express";
import { WebSocketServer } from "ws";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, createDb, migrate } from "./db.js";
import { createWorker } from "../ingest/worker.js";

import { importSnapshots, bundledSnapshots, orderBook } from "./orders.js";
import fs from 'node:fs';
import { importEvidence, bundledEvidence, evidenceBook } from './evidence.js';
import { importBundledReports, reports, refreshManufacturers } from './manufacturer-reports.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);

const pool = createPool();
await migrate(pool);
await importSnapshots(pool, bundledSnapshots());
await importEvidence(pool, bundledEvidence());
await importBundledReports(pool);
const db = createDb(pool);
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/stream" });

/* ---------- fan-out ---------- */

const clients = new Set();
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
  ws.send(JSON.stringify({ type: "hello", at: Date.now() }));
});

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// A dead client that never sends a close frame will hold a socket open
// forever. Ping every 30s and drop anything that stops answering.
setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) { ws.terminate(); clients.delete(ws); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on("connection", (ws) => { ws.isAlive = true; ws.on("pong", () => { ws.isAlive = true; }); });

/* ---------- API ---------- */

app.use(express.json());

app.get('/api/research', async (_req,res) => {
  try {
    const [manufacturer_reports,evidence,{rows:polls}]=await Promise.all([
      reports(pool),evidenceBook(pool),pool.query('SELECT * FROM research_poll')]);
    const sources=JSON.parse(fs.readFileSync(new URL('../data/sources.json',import.meta.url),'utf8'));
    res.json({manufacturer_reports,evidence,sources:sources.map(s=>({...s,poll:polls.find(p=>p.source===s.id)??null})),
      refresh_enabled:process.env.REPORT_REFRESH!=='off'});
  } catch(e) {res.status(500).json({error:'Research data unavailable'});console.error('[research]',e.message);}
});

app.get("/api/orders", async (_req, res) => {
  try { res.json(await orderBook(pool)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/roster", async (_req, res) => {
  try { res.json(await db.roster()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/events", async (req, res) => {
  try { res.json(await db.recentEvents(Math.min(200, Number(req.query.limit) || 60))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/airframe/:id", async (req, res) => {
  try {
    const all = await db.roster();
    const frame = all.find((f) => f.id === req.params.id);
    if (!frame) return res.status(404).json({ error: "No airframe with that id." });
    res.json({ ...frame, history: await db.history(frame.id), evidence: (await evidenceBook(pool)).filter(r=>r.airframe_id===frame.id && !r.superseded) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/candidates", async (_req, res) => {
  try { res.json(await db.candidates()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/** Confirm an unbound blip is a known airframe. The only write the UI makes. */
app.post("/api/candidates/:hex/bind", async (req, res) => {
  const { airframe_id } = req.body ?? {};
  if (!airframe_id) return res.status(400).json({ error: "airframe_id is required." });
  try {
    await db.bindHex(airframe_id, req.params.hex.toUpperCase());
    await pool.query("UPDATE candidate SET resolved = true WHERE hex = $1", [req.params.hex.toUpperCase()]);
    broadcast({ type: "bound", hex: req.params.hex, airframe_id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// What the system has decided by itself, and why. Every automatic binding is
// listed with its evidence, so a wrong one can be spotted and reversed.
app.get("/api/identity", async (_req, res) => {
  const [binds, pending] = await Promise.all([
    db.recentBinds(40),
    db.pendingCandidates(50),
  ]);
  res.json({ binds, pending });
});

app.delete("/api/identity/:bindId", async (req, res) => {
  const id = await db.revertBind(Number(req.params.bindId), req.body?.why ?? "manual revert");
  if (!id) return res.status(404).json({ error: "no such open binding" });
  broadcast({ type: "unbound", airframe_id: id });
  res.json({ reverted: id });
});

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, ingest: worker ? "running" : "disabled", clients: clients.size, feeds: worker ? Object.fromEntries(worker.pool.health) : {} });
  } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

/* ---------- static PWA ---------- */

app.use(express.static(path.join(__dir, "..", "web", "dist"), {
  maxAge: '1h',
  setHeaders(res,file) {
    if(file.endsWith('index.html') || file.endsWith('sw.js') || file.endsWith('.webmanifest')) res.setHeader('Cache-Control','no-cache, must-revalidate');
  }
}));
app.get(/.*/, (_req, res) =>
  res.set('Cache-Control','no-cache, must-revalidate').sendFile(path.join(__dir, "..", "web", "dist", "index.html")));

/* ---------- ingestion ---------- */

let worker = null;
if (process.env.INGEST !== "off") {
  worker = createWorker({ db, redisUrl: process.env.REDIS_URL });

  // NOTE: the spread must come FIRST and `type` last. Written the other way
  // round — { type: "milestone", ...m } — the payload's own `type` field (the
  // aircraft type, "787-9") silently overwrites the message kind, and every
  // client test for d.type === "milestone" fails forever. The aircraft type is
  // renamed to aircraft_type so the two can never collide again.
  worker.on("milestone", async (m) => {
    broadcast({ ...m, aircraft_type: m.type, type: "milestone" });
    console.log(`[milestone] ${m.stage} ${m.registration ?? m.hex} — ${m.why}`);
  });
  worker.on("provisional", (p) =>
    broadcast({ type: "provisional", stage: p.stage, airframe_id: p.airframe.id, why: p.why }));
  worker.on("candidate", (c) => broadcast({ ...c, aircraft_type: c.type, type: "candidate" }));
  // An aircraft the system named by itself. Pushed live so the roster count
  // and the frame's identity update without a reload.
  worker.on("identified", (i) => broadcast({ ...i, aircraft_type: i.type, type: "identified" }));
  worker.on("no-slot", (n) =>
    console.warn("[identity] no slot for", n.reg, n.operator, n.type,
                 "— the seeded backlog for this type may be out of date"));
  worker.on("bound", (b) => broadcast({ type: "bound", hex: b.hex, airframe_id: b.airframe.id }));
  worker.on("tick", (t) => broadcast({ type: "tick", at: t.at, health: t.health }));
  worker.on("error", (e) => console.error("[ingest]", e.message));

  // A feed that cannot be reached fails silently: ticks keep running, no
  // milestone ever fires, and the app looks like a working tracker of a very
  // quiet sky. Say out loud at startup whether anything is actually visible.
  worker.pool.probe().then((results) => {
    for (const r of results) {
      console.log(r.ok
        ? `[providers] ${r.provider}: OK, ${r.aircraft} aircraft over Charleston`
        : `[providers] ${r.provider}: UNREACHABLE — ${r.error}`);
    }
    if (!results.some((r) => r.ok)) {
      console.error("[providers] NO FEED IS REACHABLE. Nothing will be tracked. " +
                    "Set RAPIDAPI_KEY for ADSB Exchange, or check egress.");
    }
  }).catch((e) => console.error("[providers] probe failed:", e.message));

  worker.start();
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Delivery Watch on http://0.0.0.0:${PORT}`);
  console.log(`ingest: ${process.env.INGEST === "off" ? "disabled" : "running"}`);
});

// Daily source checks fetch monthly reports. A failed or changed layout leaves
// the last valid report available and exposes the error in the source directory.
let reportBusy=false;
const refreshReports=async()=>{
  if(reportBusy) return;
  reportBusy=true;
  try {await refreshManufacturers(pool);} catch(e){console.error('[reports]',e.message);} finally{reportBusy=false;}
};
let reportTimer;
if(process.env.REPORT_REFRESH!=='off') {
  refreshReports();
  reportTimer=setInterval(refreshReports,24*60*60*1000);
  reportTimer.unref();
}

const shutdown = async () => {
  console.log("\nshutting down");
  worker?.stop();
  clearInterval(reportTimer);
  for (const ws of clients) ws.close();
  server.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

