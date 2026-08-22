import React, { useEffect, useMemo, useRef, useState } from "react";

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
const stageLabel = (mfr, key) => NAMES[mfr]?.[key] ?? STAGES[SI[key]].label;

const utc = (t) => new Date(t).toISOString().slice(11, 19) + "Z";
const day = (t) => new Date(t).toISOString().slice(0, 10);
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
  const [err, setErr] = useState(null);
  const ws = useRef(null);
  const retry = useRef(0);

  /* initial load */
  useEffect(() => {
    (async () => {
      try {
        const [r, e] = await Promise.all([
          fetch("/api/roster").then((x) => x.json()),
          fetch("/api/events?limit=60").then((x) => x.json()),
        ]);
        if (r.error) throw new Error(r.error);
        setRoster(r);
        setFeed(e.map((ev) => ({
          id: `db-${ev.id}`,
          at: new Date(ev.occurred_at).getTime(),
          frame: ev.registration || ev.test_registration || `MSN ${ev.msn ?? "—"}`,
          type: ev.type_code, stage: ev.stage, mfr: ev.manufacturer,
          site: ev.site_icao ?? "—", source: ev.source, provisional: ev.provisional,
          operator: ev.operator,
        })));
      } catch (e) {
        setErr("Cannot reach the API. Check the server is running and the database is seeded.");
      }
    })();
  }, []);

  /* live stream, with reconnect */
  useEffect(() => {
    let stop = false;
    const connect = () => {
      if (stop) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const sock = new WebSocket(`${proto}://${location.host}/stream`);
      ws.current = sock;

      sock.onopen = () => { setConn("live"); retry.current = 0; };
      sock.onclose = () => {
        setConn("reconnecting");
        const wait = Math.min(30000, 1000 * 2 ** retry.current++);
        setTimeout(connect, wait);
      };
      sock.onerror = () => sock.close();
      sock.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.type === "milestone") {
          setFeed((f) => [{
            id: `${d.airframe_id}-${d.stage}-${d.at}`, at: d.at,
            frame: d.registration || d.hex, type: d.aircraft_type, stage: d.stage,
            operator: d.operator, mfr: d.manufacturer ?? "BOEING", site: d.site,
            source: "ADSB", why: d.why,
          }, ...f].slice(0, 80));
          setRoster((r) => r.map((f) =>
            f.id === d.airframe_id ? { ...f, current_stage: d.stage } : f));
          setFlash(d.airframe_id);
          setTimeout(() => setFlash(null), 1600);
        }

        // The system named an aircraft by itself: a placeholder row stops
        // being "the 12th A321neo flynas will get" and becomes HZ-NS44.
        if (d.type === "identified") {
          setFeed((f) => [{
            id: `id-${d.airframe_id}-${d.at ?? Date.now()}`, at: Date.now(),
            frame: d.registration, type: d.aircraft_type, stage: "IDENTIFIED",
            operator: d.operator, site: d.site, source: "AUTO", why: d.why,
            identified: true,
          }, ...f].slice(0, 80));
          setRoster((r) => r.map((f) =>
            f.id === d.airframe_id
              ? { ...f, registration: d.registration, icao_hex: d.hex,
                  identity_source: d.overflow ? "observed" : "inferred" }
              : f));
          setFlash(d.airframe_id);
          setTimeout(() => setFlash(null), 1600);
        }

        // Only aircraft still under consideration are worth showing. A REJECT
        // is the system correctly ignoring an in-service airliner, and there
        // are hundreds of those over Saudi Arabia every day.
        if (d.type === "candidate" && d.decision !== "REJECT") {
          setFeed((f) => [{
            id: `cand-${d.hex}-${Date.now()}`, at: Date.now(),
            frame: d.reg || d.hex, type: d.aircraft_type, stage: "UNBOUND",
            site: d.site, source: "ADSB", candidate: true, why: d.why,
          }, ...f].slice(0, 80));
        }
      };
    };
    connect();
    return () => { stop = true; ws.current?.close(); };
  }, []);

  const openFrame = async (f) => {
    setOpen(f); setDetail(null);
    try { setDetail(await fetch(`/api/airframe/${f.id}`).then((r) => r.json())); }
    catch { setDetail({ history: [] }); }
  };

  const counts = useMemo(() => {
    const c = { ordered: 0, production: 0, test: 0, delivered: 0 };
    roster.forEach((f) => {
      // The leased HZ-RXX has no order_line_id — it is not part of the
      // order book and must never inflate the delivered count.
      if (f.order_line_id == null) return;
      if (f.operator !== op) return;
      const i = SI[f.current_stage];
      if (i === 0) c.ordered++;
      else if (i < SI.FIRST) c.production++;
      else if (i < SI.SERVICE) c.test++;
      else c.delivered++;
    });
    return c;
  }, [roster, op]);

  const shown = useMemo(() => {
    const l = roster.filter((f) =>
      f.operator === op &&
      (filter === "ALL" || filter === f.manufacturer || filter === f.type_code));
    return l.slice(0, 120);
  }, [roster, filter, op]);

  /* Type chips are derived from what this operator actually has on order —
     showing an A350 chip on flyadeal would be noise. */
  const typeChips = useMemo(() => {
    const seen = new Set(roster.filter((f) => f.operator === op).map((f) => f.type_code));
    return [...seen].sort();
  }, [roster, op]);

  const opCount = (id) =>
    roster.filter((f) => f.operator === id && f.order_line_id != null).length;

  return (
    <div className="wrap">
      <header className="head">
        <div>
          <h1>Saudi Fleet<br />Delivery Watch</h1>
          <p className="sub">
            {roster.filter((f) => f.order_line_id != null).length || 444} airframes outstanding · four carriers
          </p>
        </div>
        <span className={`conn ${conn}`}><i className="dot" />{conn}</span>
      </header>

      {err && <div className="err">{err}</div>}

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

      <div className="stats">
        <div className="stat"><b className="dim">{counts.ordered}</b><span>On order</span></div>
        <div className="stat"><b style={{ color: "#C4A7FF" }}>{counts.production}</b><span>In production</span></div>
        <div className="stat"><b style={{ color: "#4ADE9B" }}>{counts.test}</b><span>Flight test</span></div>
        <div className="stat"><b style={{ color: "#E8D9A0" }}>{counts.delivered}</b><span>Delivered</span></div>
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
          <div className="grid">
            {shown.map((f) => (
              <Card key={f.id} f={f} onOpen={openFrame} flash={flash === f.id} />
            ))}
          </div>
        </section>

        <aside className="feed">
          <div className="feedhead"><h2>Event feed</h2><span className="dim">UTC</span></div>
          <div className="feedbody">
            {feed.length === 0 ? (
              <p className="empty">
                Watching KCHS, KPAE, LFBO, EDHI, LFBD and OERK.
                Milestones land here the moment a feed reports them.
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
            <div className="hist">
              {STAGES.map((s) => {
                const h = detail?.history?.find((x) => x.stage === s.key);
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
