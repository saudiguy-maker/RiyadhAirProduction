import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../db.js';
import {parseAirbus,parseBoeing,parseCSV,saveReport,reports,fetchLimited} from '../manufacturer-reports.js';
import {bundledEvidence,validateEvidence,importEvidence,decorateEvidence} from '../evidence.js';

test('Boeing repeated measures do not double-count orders, and scope stays explicit',()=>{
  const header='Country,Customer Name,Measure Names,Model Series,Order Total,Delivery Total\n';
  const source=header+'Saudi Arabia,Riyadh Air,Order Total,787-9,7,7\nSaudi Arabia,Riyadh Air,Unfilled Orders,787-9,7,7\nSaudi Arabia,Riyadh Air,Order Total,787-9,32,0\nSaudi Arabia,Saudia,Order Total,787-10,29,8\n';
  const r=parseBoeing(source,'2026-09-09');
  assert.equal(r.rows[0].ordered,39); assert.equal(r.rows[0].delivered,7);assert.equal(r.as_of,null);
  assert.throws(()=>parseBoeing(source.replace('Delivery Total','New column')),/layout/);
  assert.throws(()=>parseBoeing(source.replace('32,0','32,100')),/exceed/);
  assert.deepEqual(parseCSV('"a,b","a""b"\r\n'),[['a,b','a"b']]);
});

async function airbusFixture({badTotal=false,missing=false,wrongHeader=false}={}) {
  const wb=new ExcelJS.Workbook(),s=wb.addWorksheet('Middle East');
  s.getCell('A5').value='Summary to 31 Aug 2026';
  s.mergeCells('A17:A18');s.getCell('A17').value='CUSTOMER';
  const names=['A220-100','A220-300','A319ceo','A320ceo','A320neo','A321neo','A330-300','A330-900','A350-900','A350-1000','TOTAL'];
  names.forEach((t,i)=>{let c=7+3*i;s.mergeCells(17,c,17,c+2);s.getCell(17,c).value=t;['Ord','Del','Opr'].forEach((v,j)=>s.getCell(18,c+j).value=v);});
  if(wrongHeader)s.getCell(18,8).value='Fleet';
  ['RIYADH AIR','SAUDIA','FLYNAS',...(missing?[]:['FLYADEAL'])].forEach((name,i)=>{
    const row=19+i;s.getCell(row,1).value=name;s.getCell(row,7).value=10;s.getCell(row,8).value=3;s.getCell(row,9).value=4;
    s.getCell(row,37).value=badTotal?11:10;s.getCell(row,38).value=3;s.getCell(row,39).value=4;
  });
  return wb.xlsx.writeBuffer();
}
test('Airbus merged headers, blank cells, row controls and layout drift',async()=>{
  const url='https://mediaassets.airbus.com/test.xlsx';
  const r=await parseAirbus(await airbusFixture(),url,'2026-09-09');
  assert.equal(r.rows.length,4); assert.equal(r.as_of,'2026-08-31');assert.equal(r.rows[0].delivered,3);assert.equal(r.rows[0].in_fleet,4);
  for(const options of [{badTotal:true},{missing:true},{wrongHeader:true}]) await assert.rejects(parseAirbus(await airbusFixture(options),url));
});

test('Evidence requires identity, valid dates and independent primary support for stronger claims',()=>{
  const r=bundledEvidence()[0];
  for(const patch of [{msn:null,registration:null},{status:'confirmed'},{observed_on:'2026-02-30'},{sources:[]},{sources:[{...r.sources[0],url:'javascript:alert(1)'}]}]) assert.throws(()=>validateEvidence([{...r,...patch}]));
  assert.throws(()=>validateEvidence([{...r,status:'corroborated',review_note:'two reposts',sources:[r.sources[0],{...r.sources[0],url:'https://example.com/repost'}]}]),/independent/);
  assert.equal(validateEvidence([{...r,status:'corroborated',review_note:'Two independent observations reviewed',sources:[r.sources[0],{...r.sources[0],origin_id:'independent-photo',url:'https://example.com/original'}]}]).length,1);
});

test('Conflicting dates and serial numbers remain visible; superseded claims are retained',()=>{
  const r=bundledEvidence()[0];
  const frames=[{id:'f',manufacturer:r.manufacturer,operator:r.operator,msn:r.msn,registration:r.registration}];
  const rows=decorateEvidence([r,{...r,id:'different',observed_on:'2026-07-08'}],frames);
  assert.ok(rows.every(r=>r.needs_review)); assert.equal(rows[0].airframe_id,'f');
  assert.equal(decorateEvidence([r],[{...frames[0],msn:'111'}])[0].airframe_id,null);
  assert.equal(decorateEvidence([r],[{...frames[0],msn:'111'}])[0].needs_review,true);
  assert.equal(decorateEvidence([r,{...r,id:'replacement',supersedes:r.id}],frames).find(x=>x.id===r.id).superseded,true);
});

test('Database evidence and report imports are idempotent and preserve operational history',async()=>{
  const pg=new PGlite();const query=async(sql,p)=>p===undefined?(await pg.exec(sql)).at(-1):pg.query(sql,p);
  const pool={query,connect:async()=>({query,release(){}})};
  try {
    await migrate(pool);await migrate(pool);
    await pg.query("INSERT INTO airframe (id,manufacturer,type_code,icao_type,current_stage) VALUES ('legacy','BOEING','787-9','B789','SERVICE')");
    const r=bundledEvidence()[0];await importEvidence(pool,[r]);await importEvidence(pool,[r]);
    await assert.rejects(importEvidence(pool,[{...r,id:'new'}, {...r,summary:'changed'}]),/Conflicting/);
    assert.equal((await pg.query('SELECT count(*)::int n FROM aircraft_evidence')).rows[0].n,1);
    assert.equal((await pg.query('SELECT current_stage FROM airframe')).rows[0].current_stage,'SERVICE');
    const report=await parseAirbus(await airbusFixture(),'https://mediaassets.airbus.com/test.xlsx','2026-09-09');
    await saveReport(pool,report);await saveReport(pool,report);
    assert.equal((await reports(pool)).length,1);
    await saveReport(pool,{...report,as_of:'2026-07-31'});
    assert.equal((await reports(pool))[0].as_of,'2026-08-31');
  } finally {await pg.close();}
});

test('Oversized and failed remote downloads are rejected',async()=>{
  await assert.rejects(fetchLimited('https://example.com',2,async()=>new Response('long')),/size limit/);
  await assert.rejects(fetchLimited('https://example.com',10,async()=>new Response('',{status:429})),/429/);
});
