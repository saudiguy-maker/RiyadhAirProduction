import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code=fs.readFileSync(new URL('../public/sw.js',import.meta.url),'utf8');
function worker(fetcher) {
  const handlers={},requests=[];
  const self={location:{origin:'https://watch.test'},addEventListener:(name,fn)=>handlers[name]=fn};
  vm.runInNewContext(code,{self,URL,Request,Response,fetch:async(req,options)=>{requests.push(options);return fetcher(req);},caches:{open:async()=>({put:async()=>{}}),match:async key=>key==='/index.html'?new Response('offline shell'):undefined}});
  return {requests,run:(path,mode='navigate')=>{
    let response;handlers.fetch({request:{url:'https://watch.test'+path,method:'GET',mode},respondWith:p=>response=p,waitUntil:()=>{}});return response;
  }};
}
test('Navigation bypasses the HTTP cache and APIs stay outside the service worker',async()=>{
  const w=worker(async()=>new Response('new shell'));assert.equal(await (await w.run('/')).text(),'new shell');
  assert.equal(w.requests[0].cache,'no-store');assert.equal(w.run('/api/research'),undefined);
});
test('Offline HTML fallback is only used for navigation, never as a JavaScript asset',async()=>{
  const w=worker(async()=>{throw Error('offline');});
  assert.equal(await (await w.run('/')).text(),'offline shell');
  assert.equal((await w.run('/assets/missing.js','cors')).type,'error');
});
