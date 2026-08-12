import express from "express";
import { WebSocketServer } from "ws";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, createDb } from "./db.js";
import { createWorker } from "../ingest/worker.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);

const pool = createPool();
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
    res.json({ ...frame, history: await db.history(frame.id) });
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

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, clients: clients.size, feeds: worker ? Object.fromEntries(worker.pool.health) : {} });
  } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

/* ---------- static PWA ---------- */

app.use(express.static(path.join(__dir, "..", "web", "dist"), { maxAge: "1h" }));
app.get(/.*/, (_req, res) =>
  res.sendFile(path.join(__dir, "..", "web", "dist", "index.html")));

/* ---------- ingestion ---------- */

let worker = null;
if (process.env.INGEST !== "off") {
  worker = createWorker({ db, redisUrl: process.env.REDIS_URL });

  worker.on("milestone", async (m) => {
    broadcast({ type: "milestone", ...m });
    console.log(`[milestone] ${m.stage} ${m.registration ?? m.hex} — ${m.why}`);
  });
  worker.on("provisional", (p) =>
    broadcast({ type: "provisional", stage: p.stage, airframe_id: p.airframe.id, why: p.why }));
  worker.on("candidate", (c) => broadcast({ type: "candidate", ...c }));
  worker.on("bound", (b) => broadcast({ type: "bound", hex: b.hex, airframe_id: b.airframe.id }));
  worker.on("tick", (t) => broadcast({ type: "tick", at: t.at, health: t.health }));
  worker.on("error", (e) => console.error("[ingest]", e.message));

  worker.start();
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Delivery Watch on http://0.0.0.0:${PORT}`);
  console.log(`ingest: ${process.env.INGEST === "off" ? "disabled" : "running"}`);
});

const shutdown = async () => {
  console.log("\nshutting down");
  worker?.stop();
  for (const ws of clients) ws.close();
  server.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
