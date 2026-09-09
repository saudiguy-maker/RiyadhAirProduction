import React, {useEffect,useState} from 'react';

const date=d=>d ? String(d).slice(0,10) : 'Unknown';
const names={AIRBUS:'Airbus',BOEING:'Boeing'};
export function EvidenceList({rows}) {
  return <div className="evidence-list">{rows.map(r=><article className="evidence-card" key={r.id}>
    <div className="evidence-title"><strong>{r.registration || `MSN ${r.msn}`} · {r.label}</strong>
      <span className={`evidence-status ${r.needs_review?'disputed':r.status}`}>{r.superseded?'Superseded':r.needs_review?'Needs review':r.sources.every(s=>s.category==='enthusiast') && r.status==='reported'?'Enthusiast-reported':r.status}</span></div>
    <p>{date(r.observed_on)} · {r.manufacturer} {r.type_code} · MSN {r.msn || 'unknown'}{r.line_number && ` · LN ${r.line_number}`}</p>
    <p>{r.summary}</p>
    {r.review_reason && <p className="research-warning">{r.review_reason}. This report has not replaced the existing record.</p>}
    {r.review_note && <p>{r.review_note}</p>}
    <div className="evidence-links">{r.sources.map((s,i)=><span key={i}><a href={s.url} target="_blank" rel="noreferrer">{s.publisher}</a>
      {s.photo_url && <> · <a href={s.photo_url} target="_blank" rel="noreferrer">Original photo</a></>}</span>)}</div>
    <small>{r.independent_sources} original source group{r.independent_sources===1?'':'s'} · Checked {date(r.checked_on)} · {r.airframe_id?'Matched to tracked aircraft':'Identity awaiting reconciliation'}</small>
  </article>)}{!rows.length && <p>No reviewed evidence records for this selection yet.</p>}</div>;
}

export default function Research({operator,orders}) {
  const [data,setData]=useState(null),[error,setError]=useState('');
  const [historic,setHistoric]=useState(false),[onlyReview,setOnlyReview]=useState(false),[limit,setLimit]=useState(12);
  useEffect(()=>{
    let stopped=false;
    const load=async()=>{try{const r=await fetch('/api/research',{cache:'no-store',signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error();const d=await r.json();if(!stopped){setData(d);setError('');}}catch{if(!stopped)setError('Source research could not refresh. Previously loaded records may be out of date.');}};
    load();const timer=setInterval(load,60000);return()=>{stopped=true;clearInterval(timer);};
  },[]);
  useEffect(()=>setLimit(12),[operator,onlyReview]);
  const evidence=(data?.evidence??[]).filter(r=>r.operator===operator && !r.superseded && (!onlyReview || r.needs_review || r.status==='disputed'));
  return <>
    <section className="orderbook research">
      <h2>Manufacturer records</h2>
      <p>Orders booked to named customers. Group purchases and leased aircraft can sit under a different customer. These records are separate from the announcements below.</p>
      {error && <p role="alert" className="research-warning">{error}</p>}
      {!data && !error && <p>Loading manufacturer reports…</p>}
      <label><input type="checkbox" checked={historic} onChange={e=>setHistoric(e.target.checked)}/> Include fully delivered and fleet-only types</label>
      {(data?.manufacturer_reports??[]).map(report=>{
        const all=report.rows.filter(r=>r.operator===operator);
        const rows=all.filter(r=>historic || r.ordered>r.delivered);
        const announcement=(orders?.rows??[]).find(r=>r.operator===operator && r.scope==='Program total' &&
          (report.manufacturer==='AIRBUS'?r.type_code==='Airbus total':r.type_code==='787 family'));
        const comparable=report.manufacturer==='AIRBUS'?all:all.filter(r=>r.type_code.startsWith('787'));
        const booked=comparable.reduce((n,r)=>n+r.ordered,0);
        return <div className="manufacturer-block" key={report.id}>
          <h3>{names[report.manufacturer]} · {report.as_of?`Report to ${date(report.as_of)}`:`Retrieved ${date(report.captured_on)}; reporting cutoff unknown`}</h3>
          {announcement && announcement.firm_total!==booked && <p className="research-warning">Different source figures: this export lists {booked} {report.manufacturer==='BOEING'?'787 ':''}orders; the announcement dated {date(announcement.as_of)} lists {announcement.firm_total}. Scope, booking date or allocation needs reconciliation. Neither figure has been silently substituted.</p>}
          <div className="table-scroll"><table><thead><tr><th>Customer / aircraft</th><th>Orders</th><th>Delivered</th><th>Unfilled*</th><th>In fleet</th></tr></thead><tbody>
            {rows.map(r=><tr key={r.customer+r.type_code}><td>{r.type_code}<small>{r.customer}</small></td><td>{r.ordered}</td><td>{r.delivered}</td><td>{r.ordered-r.delivered}</td><td>{r.in_fleet??'Not supplied'}</td></tr>)}
          </tbody></table></div>
          {!rows.length && <p>No outstanding orders under this customer in the imported report. Group and lessor commitments may be recorded elsewhere.</p>}
          <details><summary>Source and accounting notes</summary><p>{report.note}</p><p>*Unfilled is orders minus deliveries within this export. It is not a combined airline backlog.</p>
            <p>Retrieved {date(report.captured_on)} · <a href={report.url} target="_blank" rel="noreferrer">Original manufacturer export</a></p>
            {rows.map(r=><small key={r.customer+r.type_code}>{r.type_code}: {r.locator}</small>)}
          </details>
        </div>;
      })}
    </section>
    <section className="orderbook research">
      <div className="evidence-title"><h2>Production evidence and sightings</h2><a href="https://github.com/saudiguy-maker/RiyadhAirProduction/issues/new?template=aircraft-evidence.yml" target="_blank" rel="noreferrer">Submit a sighting</a></div>
      <p>Reported milestones retain their original sources. Photographs establish what was visible; flight observations alone do not prove first flight, acceptance or handover. Submissions are reviewed before publication.</p>
      <label><input type="checkbox" checked={onlyReview} onChange={e=>setOnlyReview(e.target.checked)}/> Show conflicts needing review</label>
      <EvidenceList rows={evidence.slice(0,limit)}/>
      {evidence.length>limit && <button className="chip" onClick={()=>setLimit(n=>n+12)}>Show more evidence</button>}
    </section>
    <details className="orderbook research source-directory"><summary>Data sources and access</summary>
      <p>{data?.refresh_enabled?'Manufacturer reports are checked daily.':'Automatic manufacturer checks are disabled.'} Enthusiast and commercial records use reviewed imports.</p>
      <div className="source-grid">{data?.sources?.map(s=><article key={s.id}><h3><a href={s.url} target="_blank" rel="noreferrer">{s.name}</a></h3><small>{s.category}</small><p><strong>{s.mode}</strong></p><p>{s.description}</p>
        {s.poll && <p>Last check: {date(s.poll.last_checked)} · Last successful check: {date(s.poll.last_ok)}{s.poll.error && <span className="research-warning"> · Refresh failed: {s.poll.error}</span>}</p>}
      </article>)}</div>
    </details>
  </>;
}
