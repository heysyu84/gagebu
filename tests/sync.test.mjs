import test from 'node:test';
import assert from 'node:assert/strict';
import '../ledger-validation.js';
import '../ledger-sync.js';
const blank=()=>({version:2,records:[],refunds:[],dailyLotto:[],storeProfits:{}});
const sample=id=>({...blank(),records:[{id,date:'2026-11-02',amount:1000,direction:'expense',status:'confirmed'}]});
class Memory{constructor(){this.map=new Map()}getItem(k){return this.map.get(k)??null}setItem(k,v){this.map.set(k,v)}removeItem(k){this.map.delete(k)}}
function setup(localState=blank(),remoteState=null){
 const local=new Memory(),session=new Memory(),puts=[],backups=[];let state=localState,remote={version:remoteState?1:0,data:remoteState},pause=null,fail=false;
 const sync=new GagebuSync.LedgerSync({local,session,getState:()=>state,applyRemote:x=>{state=structuredClone(x);return true},confirm:()=>true,backup:x=>backups.push(x),fetch:async(url,init)=>{
  if(fail)throw Error('offline');
  if(url.endsWith('/api/login'))return Response.json({token:'a'.repeat(64),expiresAt:Date.now()/1000+3600});
  if(url.endsWith('/api/logout'))return Response.json({ok:true});
  if(init.method==='PUT'){
   const body=JSON.parse(init.body);puts.push(body);if(pause)await pause;
   if(body.version!==remote.version)return Response.json({serverVersion:remote.version},{status:409});
   remote={version:remote.version+1,data:body.data};return Response.json({ok:true,version:remote.version});
  }
  return Response.json(remote);
 }});
 return {sync,local,session,puts,backups,state:()=>state,edit:x=>{state=x;sync.localChanged()},remote:()=>remote,changeRemote:x=>{remote={version:remote.version+1,data:x}},pause:p=>{pause=p},offline:x=>{fail=x}};
}
test('first upload followed by automatic edits and confirmed server status',async()=>{
 const f=setup(sample('a'));await f.sync.login('https://api.example','password');
 assert.equal(f.remote().version,1);assert.equal(f.sync.status.kind,'saved');
 f.edit(sample('b'));await f.sync.flush();clearTimeout(f.sync.timer);
 assert.equal(f.remote().data.records[0].id,'b');assert.equal(f.sync.meta.dirty,false);
 assert(![...f.local.map.values(),...f.session.map.values()].some(x=>x.includes('password')));
});
test('a fresh empty device loads the server without uploading blank data',async()=>{
 const f=setup(blank(),sample('server'));await f.sync.login('https://api.example','password');
 assert.equal(f.state().records[0].id,'server');assert.equal(f.puts.length,0);
});
test('unrelated local/server changes stop without either side being overwritten',async()=>{
 const f=setup(sample('local'),sample('server'));await f.sync.login('https://api.example','password');
 assert.equal(f.sync.status.kind,'conflict');assert.equal(f.state().records[0].id,'local');assert.equal(f.remote().data.records[0].id,'server');assert.equal(f.puts.length,0);
 await f.sync.pull();assert.equal(f.backups[0].records[0].id,'local');assert.equal(f.state().records[0].id,'server');
});
test('edits made during an in-flight save are sent in a subsequent revision',async()=>{
 const f=setup(sample('a'));await f.sync.login('https://api.example','password');
 let release;f.pause(new Promise(r=>release=r));f.edit(sample('b'));const saving=f.sync.flush();f.edit(sample('c'));release();await saving;
 assert.equal(f.sync.meta.dirty,true);f.pause(null);await f.sync.flush();clearTimeout(f.sync.timer);
 assert.equal(f.remote().version,3);assert.equal(f.remote().data.records[0].id,'c');
});
test('offline edits stay dirty and are recovered on reconnect',async()=>{
 const f=setup(sample('a'));await f.sync.login('https://api.example','password');f.offline(true);f.edit(sample('b'));await f.sync.flush();clearTimeout(f.sync.timer);
 assert.equal(f.sync.status.kind,'error');assert.equal(f.state().records[0].id,'b');assert(f.sync.meta.dirty);
 f.offline(false);await f.sync.start();assert.equal(f.remote().data.records[0].id,'b');assert.equal(f.sync.status.kind,'saved');
});
test('conflicting device writes block, then explicit push backs up server data',async()=>{
 const f=setup(sample('a'));await f.sync.login('https://api.example','password');f.changeRemote(sample('other'));f.edit(sample('mine'));await f.sync.flush();clearTimeout(f.sync.timer);
 assert.equal(f.sync.status.kind,'conflict');assert.equal(f.remote().data.records[0].id,'other');
 await f.sync.push();assert.equal(f.backups[0].records[0].id,'other');assert.equal(f.remote().data.records[0].id,'mine');
});
test('invalid or credential-bearing API URLs are rejected',async()=>{
 const f=setup();for(const url of ['http://api.example','https://user:pass@api.example','https://api.example/path','https://api.example?token=abc'])await assert.rejects(f.sync.login(url,'password'));
});
test('reconnect waits for an in-flight save instead of comparing stale server data',async()=>{
 const f=setup(sample('a'));await f.sync.login('https://api.example','password');
 let release;f.pause(new Promise(resolve=>release=resolve));f.edit(sample('b'));
 const saving=f.sync.flush(),reconnecting=f.sync.start();release();
 await Promise.all([saving,reconnecting]);clearTimeout(f.sync.timer);
 assert.equal(f.sync.status.kind,'saved');assert.equal(f.sync.stopped,false);
 assert.equal(f.remote().data.records[0].id,'b');assert.equal(f.puts.length,2);
});
