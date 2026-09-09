import React, { useEffect, useMemo, useRef, useState } from "react";



import { countsFor, feedStatus, safeStageLabel, isTrackedOrder } from "./model.js";



const STAGES = [

  { key: "ORDERED",  short: "ORD",  label: "Ordered" },

  { key: "SLOT",     short: "SLOT", label: "Slot assigned" },

  { key: "ASSEMBLY", short: "FAL",  label: "Final assembly" },

  { key: "ROLLOUT",  short: "ROLL", label: "Rollout" },

  { key: "GROUND",   short: "GRD",  label: "Ground test" },

  { key: "FIRST",    short: "FF",   label: "First flight" },

  { key: "PAINT",    short: "PNT",  label: "Paint" },

  { key: "CUSTOMER", short: "CAF",  label: "Customer flight" },

  { key: "DELIVERY", short: "DLV",  label: "Delivery flight" },

  { key: "SERVICE",  short: "SVC",  label: "In service" },

];

const SI = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));



const SOURCE = {

  ADSB:            { label: "ADS-B",      color: "#4ADE9B" },

  SPOTTER:         { label: "Spotter",    color: "#C4A7FF" },

  REGISTRY:        { label: "Registry",   color: "#7FB3FF" },

  PRODUCTION_LIST: { label: "Prod. list", color: "#E8B87F" },

  MANUFACTURER:    { label: "O&D table",  color: "#8A7CA8" },

};



const ACCENT = {

  "787-9": "#6C3FD1", "787-10": "#8B5CF6", "787-9/-10": "#8B5CF6",

  "A350-1000": "#C4A7FF", "A321neo": "#7FB3FF",

  "A320neo": "#5FA8E0", "A320neo family": "#5FA8E0", "A330-900": "#D4A24C",

};



const OPERATORS = {

  RXI: { name: "Riyadh Air", accent: "#6C3FD1" },

  SVA: { name: "Saudia",     accent: "#3E9E7A" },

  NAS: { name: "flynas",     accent: "#D4A24C" },

  FAD: { name: "flyadeal",   accent: "#9B5FC0" },

};

const OP_ORDER = ["RXI", "SVA", "NAS", "FAD"];



const NAMES = {

  BOEING: { FIRST: "B-1 flight", CUSTOMER: "C-1 customer flight", ASSEMBLY: "Final body join" },

  AIRBUS: { ASSEMBLY: "FAL station", CUSTOMER: "Acceptance flight" },

};

const stageLabel = (mfr, key) => safeStageLabel(mfr, key, STAGES, SI, NAMES);



const utc = (t) => Number.isFinite(new Date(t).getTime()) ? new Date(t).toISOString().slice(11, 19) + "Z" : "Unknown time";

const day = (t) => t && Number.isFinite(new Date(t).getTime()) ? new Date(t).toISOString().slice(0, 10) : "Unknown date";

const ident = (f) =>

  f.registration || f.test_registration || (f.msn ? `MSN ${f.msn}` : "Not yet allocated");



function Rail({ stage, accent }) {

  const i = SI[stage];

  return (

    <div className="rail">

      {STAGES.map((s, k) => (

        <span key={s.key}

          className={`seg${k === i && i > 0 && i < 9 ? " head" : ""}`}

          style={{ background: k <= i ? (i >= SI.SERVICE ? "#E8D9A0" : accent) : "#33204F" }} />

      ))}

    </div>

  );

}



function Card({ f, onOpen, flash }) {

  const accent = ACCENT[f.type_code] ?? "#6C3FD1";

  return (

    <button className={`card${flash ? " flash" : ""}`} onClick={() => onOpen(f)}>

      <div className="cardtop">

        <span className="ident">{ident(f)}</span>

        <span className="type" style={{ color: accent }}>{f.type_code}</span>

      </div>

      <div className="meta">

        <span>{f.manufacturer === "BOEING" ? "Boeing" : "Airbus"}</span>

        {f.identity_source === "verified" && <span className="ver">verified</span>}

        {f.identity_source === "partial" && <span className="part">partial</span>}

        {f.line_number && <span>LN {f.line_number}</span>}

        {f.msn && !f.registration && <span>MSN {f.msn}</span>}

        {f.icao_hex && <span className="hex">{f.icao_hex}</span>}

      </div>

      <Rail stage={f.current_stage} accent={accent} />

      <div className="stagerow">

        <span style={{ color: f.current_stage === "SERVICE" ? "#E8D9A0" : "#F2EDFF" }}>

          {stageLabel(f.manufacturer, f.current_stage)}

        </span>

        <span className="dim">{SI[f.current_stage]}/9</span>

      </div>

    </button>

  );

}



export default function App() {

  const [roster, setRoster] = useState([]);

  const [feed, setFeed] = useState([]);

  const [conn, setConn] = useState("connecting");

  const [op, setOp] = useState("RXI");

  const [filter, setFilter] = useState("ALL");

  const [open, setOpen] = useState(null);

  const [detail, setDetail] = useState(null);

  const [flash, setFlash] = useState(null);

  const detailRequest = useRef(0);

  const [err, setErr] = useState(null);

  const [health, setHealth] = useState(null);

  const [orders, setOrders] = useState(null);

  const [now, setNow] = useState(Date.now());

  const [showProjected, setShowProjected] = useState(false);

  const [visibleCount, setVisibleCount] = useState(120);

  const ws = useRef(null);

  const retry = useRef(0);



  /* Fetch a fresh snapshot on reconnect; missed messages are not replayed by WS. */

  useEffect(() => {

    let stopped = false, generation = 0, retryTimer, refreshTimer;

    async function get(url) {

      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000) });

      if (!r.ok) throw new Error(`Request failed: ${r.status}`);

      return r.json();

    }

    async function refresh() {

      const version = ++generation;

      try {

        const [r, e, h, o] = await Promise.all([

          get("/api/roster"), get("/api/events?limit=60"), get("/api/health"), get("/api/orders"),

        ]);

        if (stopped || version !== generation) return;

        setRoster(r); setHealth(h); setOrders(o); setErr(null);

        setFeed(e.map(ev => ({

          id: `db-${ev.id}`, at: ev.occurred_at,

          frame: ev.registration || ev.test_registration || `MSN ${ev.msn ?? "—"}`,

          type: ev.type_code, stage: ev.stage, mfr: ev.manufacturer,

          site: ev.site_icao ?? "—", source: ev.source, provisional: ev.provisional,

          operator: ev.operator,

        })));

      } catch {

        if (!stopped && version === generation) {

          setHealth(null);

          setErr("Could not refresh data. Previously loaded records may be out of date.");

        }

      }

    }

    const scheduleRefresh = () => {

      if (refreshTimer) return;

      refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 250);

    };

    const connect = () => {

      if (stopped) return;

      const proto = location.protocol === "https:" ? "wss" : "ws";

      const sock = new WebSocket(`${proto}://${location.host}/stream`);

      ws.current = sock;

      sock.onopen = () => { setConn("connected"); retry.current = 0; refresh(); };

      sock.onclose = () => {

        if (stopped) return;

        setConn("reconnecting");

        retryTimer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retry.current++));

      };

      sock.onerror = () => sock.close();

      sock.onmessage = m => {

        let d;

        try { d = JSON.parse(m.data); } catch { return; }

        if (d.type === "tick") setHealth({ ingest: "running", feeds: d.health });

        if (["milestone", "identified", "bound", "unbound", "provisional"].includes(d.type)) {

          scheduleRefresh();

          setFlash(d.airframe_id);

        }

      };

    };

    refresh(); connect();

    const timer = setInterval(() => { setNow(Date.now()); refresh(); }, 30000);

    return () => {

      stopped = true; generation++;

      clearInterval(timer); clearTimeout(retryTimer); clearTimeout(refreshTimer);

      ws.current?.close();

    };

  }, []);



  const openFrame = async (f) => {

    const request = ++detailRequest.current;

    setOpen(f); setDetail(null);

    try {

      const response = await fetch(`/api/airframe/${encodeURIComponent(f.id)}`);

      if (!response.ok) throw new Error("Details unavailable");

      const value = await response.json();

      if (request === detailRequest.current) setDetail(value);

    } catch { if (request === detailRequest.current) setDetail({ history: [], error: "History could not be loaded" }); }

  };



  const counts = useMemo(() => countsFor(roster, op), [roster, op]);

  const status = feedStatus(conn, health, now);

  const shown = useMemo(() => roster.filter(f =>

    f.operator === op && isTrackedOrder(f) &&

    (showProjected || f.identity_source !== "projected") &&

    (filter === "ALL" || filter === f.manufacturer || filter === f.type_code)),

    [roster, filter, op, showProjected]);

  useEffect(() => { setVisibleCount(120); }, [op, filter, showProjected]);



  /* Type chips are derived from what this operator actually has on order —

     showing an A350 chip on flyadeal would be noise. */

  const typeChips = useMemo(() => {

    const seen = new Set(roster.filter((f) => f.operator === op).map((f) => f.type_code));

    return [...seen].sort();

  }, [roster, op]);



  const opCount = (id) =>

    roster.filter((f) => f.operator === id && isTrackedOrder(f) && f.identity_source !== "projected").length;



  return (

    <div className="wrap">

      <header className="head">

        <div>

          <h1>Saudi Fleet<br />Delivery Watch</h1>

          <p className="sub">

            Aircraft observations and sourced orders

          </p>

        </div>

        <span className={`conn ${status === "live" ? "live" : "reconnecting"}`}><i className="dot" />{status}</span>

      </header>



      {err && <div className="err">{err}</div>}



      <p className="sub">Carrier badges count identified aircraft, including recorded handovers. They are not backlog totals.</p>

      <nav className="ops">

        {OP_ORDER.map((id) => (

          <button key={id} className={`op${op === id ? " on" : ""}`}

            onClick={() => { setOp(id); setFilter("ALL"); }}

            style={op === id ? { borderBottomColor: OPERATORS[id].accent, color: "#F2EDFF" } : undefined}>

            <span className="opname">{OPERATORS[id].name}</span>

            <span className="opn" style={{ color: op === id ? OPERATORS[id].accent : undefined }}>

              {opCount(id) || "—"}

            </span>

          </button>

        ))}

      </nav>



      <section className="orderbook">

        <h2>Sourced order book</h2>

        <p>{orders?.notice ?? "Order sources have not loaded."}</p>

        <div className="table-scroll"><table>

          <thead><tr><th>Aircraft / scope</th><th>Firm</th><th>Delivered at source date</th><th>Remaining at source date</th><th>Source date</th><th>Evidence</th></tr></thead>

          <tbody>{(orders?.rows ?? []).filter(o => o.operator === op ||

            (o.operator === "SVA_GROUP" && ["SVA", "FAD"].includes(op))).map(o => (

            <tr key={o.id}>

              <td>{o.type_code}<small>{o.operator === "SVA_GROUP" ? "Saudia + flyadeal group order" : o.scope}</small>

                <details><summary>Details</summary><p>{o.note}</p>

                  <p>Options: {o.options_total ?? "Unknown"} · Pending: {o.pending_total ?? "Unknown"}</p>

                  <p>Source checked: {day(o.checked_on)}</p></details></td>

              <td>{o.firm_total ?? "Unknown"}</td><td>{o.delivered_total ?? "Unknown"}</td>

              <td>{o.remaining_at_source_date ?? "Unknown"}</td><td>{day(o.as_of)}</td>

              <td>{o.sources.map((source,i) => <a key={i} href={source.url} target="_blank" rel="noreferrer">{source.publisher}</a>)}</td>

            </tr>

          ))}</tbody>

        </table></div>

      </section>

      <h2>Observed aircraft</h2>

      <p className="sub">Recorded stages are separate from manufacturer order balances. ADS-B suggestions appear as provisional events.</p>

      <div className="stats">

        <div className="stat"><b className="dim">{counts.ordered}</b><span>Stage unknown</span></div>

        <div className="stat"><b style={{ color: "#C4A7FF" }}>{counts.production}</b><span>In production</span></div>

        <div className="stat"><b style={{ color: "#4ADE9B" }}>{counts.test}</b><span>Flight test</span></div>

        <div className="stat"><b style={{ color: "#E8D9A0" }}>{counts.delivered}</b><span>Recorded handovers</span></div>

      </div>



      <div className="cols">

        <section>

          <div className="chips">

            {["ALL", ...typeChips].map((k) => (

              <button key={k} className={`chip${filter === k ? " on" : ""}`} onClick={() => setFilter(k)}>

                {k === "ALL" ? "All" : k}

              </button>

            ))}

          </div>

          <label className="sub"><input type="checkbox" checked={showProjected} onChange={e => setShowProjected(e.target.checked)} /> Show legacy unallocated placeholders (unreconciled)</label>

          <p className="sub">Showing {Math.min(visibleCount, shown.length)} of {shown.length} aircraft</p>

          <div className="grid">

            {shown.slice(0, visibleCount).map((f) => (

              <Card key={f.id} f={f} onOpen={openFrame} flash={flash === f.id} />

            ))}

          </div>

          {shown.length === 0 && <p className="empty">No identified aircraft loaded for this selection. See the sourced order book above.</p>}

          {shown.length > visibleCount && <button className="chip" onClick={() => setVisibleCount(n => n + 120)}>Show more aircraft</button>}

        </section>



        <aside className="feed">

          <div className="feedhead"><h2>Event feed</h2><span className="dim">UTC</span></div>

          <div className="feedbody">

            {feed.length === 0 ? (

              <p className="empty">

                No recent milestones recorded. Check feed status above for current coverage.

              </p>

            ) : feed.map((e) => (

              <article className="ev" key={e.id}>

                <div className="evtop">

                  <span>{utc(e.at)} · {e.site}</span>

                  <span className="src" style={{ color: SOURCE[e.source]?.color ?? "#8A7CA8" }}>

                    {e.candidate ? "unbound" : SOURCE[e.source]?.label ?? e.source}

                  </span>

                </div>

                <div className="evmain">

                  {e.operator && OPERATORS[e.operator] && (

                    <span className="opdot" style={{ background: OPERATORS[e.operator].accent }} />

                  )}

                  <span style={{ color: ACCENT[e.type] ?? "#C4A7FF" }}>{e.frame}</span>

                  {" · "}

                  {e.candidate ? "New contact, awaiting binding" : stageLabel(e.mfr, e.stage)}

                  {e.provisional && <em className="prov"> provisional</em>}

                </div>

              </article>

            ))}

          </div>

        </aside>

      </div>



      {open && (

        <div className="sheet" onClick={() => setOpen(null)}>

          <div className="sheetin" onClick={(e) => e.stopPropagation()}>

            <button className="close" onClick={() => setOpen(null)}>Close</button>

            <h2 className="bigid">{ident(open)}</h2>

            <div className="meta">

              <span style={{ color: ACCENT[open.type_code] }}>{open.type_code}</span>

              {open.msn && <span>MSN {open.msn}</span>}

              {open.line_number && <span>LN {open.line_number}</span>}

              {open.icao_hex && <span className="hex">HEX {open.icao_hex}</span>}

            </div>

            <Rail stage={open.current_stage} accent={ACCENT[open.type_code] ?? "#6C3FD1"} />

            {detail?.error && <p className="err">{detail.error}</p>}

            <div className="hist">

              {STAGES.map((s) => {

                const h = detail?.history?.find((x) => x.stage === s.key && !x.provisional);

                return (

                  <div className="hrow" key={s.key} style={{ opacity: h ? 1 : 0.3 }}>

                    <span className="k">{s.short}</span>

                    <span className="s">{stageLabel(open.manufacturer, s.key)}</span>

                    <span className="dim">{h ? day(h.occurred_at) : "pending"}</span>

                    {h && <span className="src" style={{ color: SOURCE[h.source]?.color }}>

                      {SOURCE[h.source]?.label ?? h.source}

                    </span>}

                  </div>

                );

              })}

            </div>

          </div>

        </div>

      )}

    </div>

  );

}



