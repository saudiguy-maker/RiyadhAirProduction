import fs from 'node:fs';
import {fetchManufacturer} from './manufacturer-reports.js';
const rows=[];
for(const kind of ['AIRBUS','BOEING']) rows.push(await fetchManufacturer(kind));
const output=process.argv[2];
if(!output) throw new Error('Usage: node server/refresh-reports.js output.json');
fs.writeFileSync(output,JSON.stringify(rows,null,2)+'\n');
console.log('Saved validated manufacturer reports. Production also checks these sources daily.');
