import fs from 'node:fs';
import crypto from 'node:crypto';

export const stages = { SLOT:'Slot reported', ASSEMBLY:'Assembly reported', ROLLOUT:'Rollout', PAINT:'Seen in livery', GROUND:'Ground activity', FIRST:'First flight reported', TEST:'Flight observed', CUSTOMER:'Customer acceptance flight reported', DELIVERY:'Delivery reported', SERVICE:'Entry into service reported' };
const categories=['manufacturer','airline','lessor','enthusiast','fleet_database','flight_tracking'];
export function httpsURL(s) { const u=new URL(s); if(u.protocol!=='https:' || u.username || u.password) throw new Error('Public HTTPS evidence link required'); return s; }
export function validateEvidence(rows) {
  if(!Array.isArray(rows)) throw new Error('Expected evidence array');
  const ids=new Set();
  for(const r of rows) {
    for(const k of ['id','manufacturer','operator','type_code','milestone','observed_on','checked_on','summary','status'])
      if(typeof r[k]!=='string' || !r[k].trim() || r[k].length>2000) throw new Error(`Invalid ${k}`);
    if(!['AIRBUS','BOEING'].includes(r.manufacturer) || !['RXI','SVA','NAS','FAD'].includes(r.operator) || !stages[r.milestone]) throw new Error('Unknown evidence identity or milestone');
    if(!r.msn && !r.registration) throw new Error('MSN or registration required');
    if(r.msn && !/^\d{1,10}$/.test(String(r.msn))) throw new Error('Invalid MSN');
    if(r.registration && !/^[A-Z0-9-]{3,15}$/.test(r.registration)) throw new Error('Invalid registration');
    for(const d of [r.observed_on,r.checked_on])
      if(!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0,10)!==d) throw new Error('Invalid evidence date');
    if(r.observed_on>r.checked_on || r.checked_on>new Date().toISOString().slice(0,10)) throw new Error('Future evidence date');
    if(!['reported','corroborated','confirmed','inferred','disputed'].includes(r.status)) throw new Error('Unknown evidence status');
    if(!Array.isArray(r.sources)||!r.sources.length) throw new Error('Evidence source required');
    for(const s of r.sources) {
      httpsURL(s.url);
      if(!s.publisher || !s.origin_id || !categories.includes(s.category)) throw new Error('Source publisher, category and original observation ID required');
      if(s.photo_url) httpsURL(s.photo_url);
    }
    if(r.status==='confirmed' && !r.sources.some(s=>['manufacturer','airline','lessor'].includes(s.category))) throw new Error('Confirmed milestone needs primary evidence');
    if(r.status==='corroborated' && new Set(r.sources.map(s=>s.origin_id)).size<2) throw new Error('Repeated reports are not independent evidence');
    if(['confirmed','corroborated','disputed'].includes(r.status) && !r.review_note) throw new Error('Review explanation required');
    if(ids.has(r.id)) throw new Error('Duplicate evidence ID'); ids.add(r.id);
  }
  return rows;
}
export const bundledEvidence=()=>validateEvidence(JSON.parse(fs.readFileSync(new URL('../data/evidence.json',import.meta.url),'utf8')));
export async function importEvidence(pool, rows) {
  validateEvidence(rows);
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    for(const r of rows) {
      const payload=JSON.stringify(r); const hash=crypto.createHash('sha256').update(payload).digest('hex');
      if(r.supersedes) {
        const prior=await c.query('SELECT payload FROM aircraft_evidence WHERE id=$1',[r.supersedes]);
        if(!prior.rows.length || r.supersedes===r.id) throw new Error('Superseded record must exist');
      }
      const added=await c.query('INSERT INTO aircraft_evidence (id,content_hash,payload) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id',[r.id,hash,payload]);
      if(!added.rows.length) {
        const old=await c.query('SELECT content_hash FROM aircraft_evidence WHERE id=$1',[r.id]);
        if(old.rows[0].content_hash!==hash) throw new Error(`Conflicting evidence ${r.id}; add a new record with supersedes`);
      }
    }
    await c.query('COMMIT');
  } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
export function decorateEvidence(rows, frames, history=[]) {
  const superseded=new Set(rows.map(r=>r.supersedes).filter(Boolean));
  return rows.map(r=>{
    const matches=frames.filter(f=>f.manufacturer===r.manufacturer && f.operator===r.operator &&
      (r.msn && f.msn ? String(r.msn)===String(f.msn) : r.registration && r.registration===f.registration));
    const frame=matches.length===1 ? matches[0] : null;
    const identityConflict=frames.some(f=>f.manufacturer===r.manufacturer && f.registration===r.registration && f.msn && r.msn && String(f.msn)!==String(r.msn));
    const sameAircraft=other=>r.manufacturer===other.manufacturer && (r.msn && other.msn ? String(r.msn)===String(other.msn) : r.registration && r.registration===other.registration);
    const conflict=rows.some(other=>other.id!==r.id && !superseded.has(other.id) && sameAircraft(other) && other.milestone===r.milestone && other.observed_on!==r.observed_on);
    const legacyConflict=frame && history.some(e=>e.airframe_id===frame.id && e.stage===r.milestone && !e.provisional && new Date(e.occurred_at).toISOString().slice(0,10)!==r.observed_on);
    return {...r,label:stages[r.milestone],airframe_id:frame?.id??null,superseded:superseded.has(r.id),
      independent_sources:new Set(r.sources.map(s=>s.origin_id)).size,
      needs_review:!!(identityConflict || conflict || legacyConflict),
      review_reason:identityConflict?'Serial number disagrees with existing registration record':conflict?'Sources report different dates':legacyConflict?'Date differs from legacy stage history':null};
  }).sort((a,b)=>b.observed_on.localeCompare(a.observed_on));
}
export async function evidenceBook(pool) {
  const [{rows},{rows:frames},{rows:history}]=await Promise.all([
    pool.query('SELECT payload FROM aircraft_evidence ORDER BY imported_at'),
    pool.query('SELECT id,manufacturer,operator,msn,registration FROM airframe'),
    pool.query('SELECT airframe_id,stage,occurred_at,provisional FROM stage_event WHERE provisional=false')]);
  return decorateEvidence(rows.map(r=>r.payload),frames,history);
}
