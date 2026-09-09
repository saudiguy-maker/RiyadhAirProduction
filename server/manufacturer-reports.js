import ExcelJS from 'exceljs';
import crypto from 'node:crypto';
import fs from 'node:fs';

export const AIRBUS_PAGE = 'https://www.airbus.com/en/products-services/commercial-aircraft/orders-and-deliveries';
export const BOEING_PAGE = 'https://www.boeing.com/commercial#orders-deliveries';
export const BOEING_EXPORT = 'https://public.tableau.com/views/BoeingCommercialOrdersDeliveries_16788064876590/OrdersandDeliveries.csv?:showVizHome=no';
const operators = { 'RIYADH AIR': 'RXI', SAUDIA: 'SVA', FLYNAS: 'NAS', FLYADEAL: 'FAD' };
const today = () => new Date().toISOString().slice(0,10);
const value = cell => cell?.result ?? cell;
const number = v => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid manufacturer count');
  return n;
};

export async function parseAirbus(buffer, url, captured_on = today()) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.getWorksheet('Middle East');
  if (!sheet) throw new Error('Airbus layout changed: Middle East sheet absent');
  const dateText = String(sheet.getCell('A5').value);
  const match = /^Summary to (\d{1,2} [A-Za-z]{3} \d{4})$/.exec(dateText);
  if (!match || !Number.isFinite(Date.parse(match[1]+' UTC'))) throw new Error('Airbus report date absent');
  const as_of = new Date(match[1]+' UTC').toISOString().slice(0,10);
  let header;
  sheet.eachRow((r,n) => { if (!header && r.getCell(1).value === 'CUSTOMER') header = n; });
  if (!header) throw new Error('Airbus customer header absent');
  const types = [];
  sheet.getRow(header).eachCell((cell,col) => {
    if (cell.isMerged && cell.master.address !== cell.address) return;
    const name = value(cell.value);
    if (/^A\d/.test(String(name)) || name === 'TOTAL') {
      if (sheet.getCell(header+1,col).value !== 'Ord' || sheet.getCell(header+1,col+1).value !== 'Del' || sheet.getCell(header+1,col+2).value !== 'Opr') throw new Error('Airbus column definitions changed');
      types.push({name,col});
    }
  });
  if (types.length < 10 || !types.some(t=>t.name==='TOTAL')) throw new Error('Incomplete Airbus type headers');
  const rows = [], found = new Set();
  sheet.eachRow((r,n) => {
    const customer = String(r.getCell(1).value ?? '').trim();
    const operator = operators[customer];
    if (!operator || n <= header) return;
    if (found.has(customer)) throw new Error('Duplicate Airbus customer');
    found.add(customer);
    const counts = types.map(t => ({ customer, operator, type_code:t.name,
      ordered:number(value(r.getCell(t.col).value)), delivered:number(value(r.getCell(t.col+1).value)),
      in_fleet:number(value(r.getCell(t.col+2).value)), locator:`Middle East!${r.getCell(t.col).address}:${r.getCell(t.col+2).address}` }));
    const total = counts.find(t=>t.type_code==='TOTAL');
    for (const key of ['ordered','delivered','in_fleet'])
      if (counts.filter(t=>t!==total).reduce((n,t)=>n+t[key],0) !== total[key]) throw new Error(`Airbus ${customer} ${key} does not reconcile`);
    rows.push(...counts.filter(t=>t.type_code!=='TOTAL' && (t.ordered || t.delivered || t.in_fleet)));
  });
  if (found.size !== 4) throw new Error('Airbus report missing a tracked customer');
  return validateReport({manufacturer:'AIRBUS',as_of,captured_on,url,rows,
    note:'Cumulative customer accounting, including historic types. Blank numeric cells are zero entries in this report, not evidence that an operator has no group or leased commitments. In-fleet aircraft include other sources and are not deliveries. Saudia customer allocations must not be added to the separate Saudia Group announcement.'});
}

export function parseCSV(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i=0;i<text.length;i++) {
    const c=text[i];
    if (c==='"') { if (quoted && text[i+1]==='"') { field+='"'; i++; } else quoted=!quoted; }
    else if (!quoted && (c===',' || c==='\n')) { row.push(field.replace(/\r$/,'')); field=''; if(c==='\n'){ rows.push(row); row=[]; } }
    else field+=c;
  }
  if (quoted) throw new Error('Unterminated CSV field');
  if(field || row.length){row.push(field.replace(/\r$/,''));rows.push(row);}
  return rows;
}

export function parseBoeing(text, captured_on = today()) {
  const [header,...data] = parseCSV(text.replace(/^\uFEFF/,''));
  const required = ['Country','Customer Name','Measure Names','Model Series','Order Total','Delivery Total'];
  if (!required.every(k=>header?.includes(k))) throw new Error('Boeing export layout changed');
  const index=Object.fromEntries(header.map((h,i)=>[h,i]));
  const grouped=new Map();
  for(const row of data) {
    if(row.length!==header.length) throw new Error('Incomplete Boeing export row');
    if(row[index['Measure Names']]!=='Order Total') continue; // The export repeats each fact for other measures.
    const customer=row[index['Customer Name']]; const operator=operators[customer.toUpperCase()];
    if(!operator) continue;
    const type_code=row[index['Model Series']]; const key=customer+':'+type_code;
    const entry=grouped.get(key)??{customer,operator,type_code,ordered:0,delivered:0,in_fleet:null,locator:'Order Total measure, grouped by Customer Name and Model Series'};
    for(const [key,col] of [['ordered','Order Total'],['delivered','Delivery Total']]) entry[key]+=number(row[index[col]]);
    grouped.set(key,entry);
  }
  const rows=[...grouped.values()];
  if(!rows.some(r=>r.operator==='RXI') || !rows.some(r=>r.operator==='SVA')) throw new Error('Boeing export missing tracked customers');
  return validateReport({manufacturer:'BOEING',as_of:null,captured_on,url:BOEING_EXPORT,rows,
    note:'Public Boeing Tableau export, cumulative named-customer orders and deliveries. Reporting cutoff is not supplied by this export; the displayed date is retrieval date only. Order Total is preserved as reported, without assuming ASC 606 adjustments or reallocating unidentified/lessor orders. Announcements may differ from booked orders.'});
}

export function validateReport(r) {
  if(!['AIRBUS','BOEING'].includes(r.manufacturer) || !Array.isArray(r.rows) || !r.rows.length || !r.note) throw new Error('Invalid report');
  for(const d of [r.captured_on,...(r.as_of?[r.as_of]:[])])
    if(!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0,10)!==d || d>today()) throw new Error('Invalid report date');
  if(r.as_of && r.as_of>r.captured_on) throw new Error('Report date after retrieval');
  if(new URL(r.url).protocol!=='https:') throw new Error('HTTPS report URL required');
  const keys=new Set();
  for(const row of r.rows) {
    if(!row.customer || !row.type_code || !row.locator || !Object.values(operators).includes(row.operator)) throw new Error('Invalid report identity');
    for(const k of ['ordered','delivered']) { if(row[k]===null || row[k]===undefined || number(row[k])!==row[k]) throw new Error('Missing report count'); }
    if(row.delivered>row.ordered) throw new Error('Report deliveries exceed orders');
    if(row.in_fleet!==null && number(row.in_fleet)!==row.in_fleet) throw new Error('Invalid fleet count');
    const key=row.customer+':'+row.type_code; if(keys.has(key)) throw new Error('Duplicate report series'); keys.add(key);
  }
  return r;
}

export async function saveReport(pool, report) {
  validateReport(report);
  if(report.as_of) {
    const {rows}=await pool.query('SELECT max(as_of) AS latest FROM manufacturer_report WHERE manufacturer=$1',[report.manufacturer]);
    if(rows[0]?.latest && new Date(rows[0].latest).toISOString().slice(0,10)>report.as_of) return;
  }
  // Retrieval time is not a new source revision. Keep each distinct content version.
  const digest=crypto.createHash('sha256').update(JSON.stringify({...report,captured_on:undefined})).digest('hex');
  await pool.query('INSERT INTO manufacturer_report (id,manufacturer,as_of,captured_on,payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    [digest,report.manufacturer,report.as_of,report.captured_on,JSON.stringify(report)]);
}
export async function reports(pool) {
  const {rows}=await pool.query('SELECT DISTINCT ON (manufacturer) id,payload,imported_at FROM manufacturer_report ORDER BY manufacturer, captured_on DESC, imported_at DESC');
  return rows.map(r=>({...r.payload,id:r.id}));
}
export async function fetchLimited(url, maxBytes=10_000_000, fetcher=fetch) {
  const r=await fetcher(url,{signal:AbortSignal.timeout(45000)});
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  const chunks=[]; let size=0;
  for await (const chunk of r.body) { size+=chunk.length; if(size>maxBytes) throw new Error('Report exceeds size limit'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export async function fetchManufacturer(kind) {
  if(kind==='BOEING') return parseBoeing((await fetchLimited(BOEING_EXPORT)).toString('utf8'));
  const html=(await fetchLimited(AIRBUS_PAGE)).toString('utf8');
  const urls=[...html.matchAll(/https:\/\/mediaassets\.airbus\.com\/[^"'<>\s]+/g)].map(m=>m[0].replaceAll('&amp;','&'));
  const url=urls.find(u=>/\.xlsx(?:\?|$)/i.test(u) && /orders.and.deliveries/i.test(u));
  if(!url) throw new Error('Airbus workbook link not found; needs review');
  if(new URL(url).hostname!=='mediaassets.airbus.com') throw new Error('Unexpected Airbus host');
  return parseAirbus(await fetchLimited(url),url);
}
export async function importBundledReports(pool) {
  for(const r of JSON.parse(fs.readFileSync(new URL('../data/manufacturer-reports.json',import.meta.url),'utf8'))) await saveReport(pool,r);
}
export async function refreshManufacturers(pool) {
  for(const kind of ['AIRBUS','BOEING']) {
    try {
      await saveReport(pool,await fetchManufacturer(kind));
      await pool.query(`INSERT INTO research_poll (source,last_checked,last_ok,error) VALUES ($1,now(),now(),NULL)
        ON CONFLICT (source) DO UPDATE SET last_checked=now(),last_ok=now(),error=NULL`,[kind]);
    } catch(e) {
      console.warn(`[reports] ${kind}: ${e.message}`);
      await pool.query(`INSERT INTO research_poll (source,last_checked,error) VALUES ($1,now(),$2)
        ON CONFLICT (source) DO UPDATE SET last_checked=now(),error=$2`,[kind,e.message]);
    }
  }
}
