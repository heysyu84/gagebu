import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import '../ledger-validation.js';
import '../ledger-sync.js';
const blank=()=>({version:2,records:[],refunds:[],dailyLotto:[],storeProfits:{}});
const sample=id=>({...blank(),records:[{id,date:'2026-11-02',amount:1000,direction:'expense',status:'confirmed'}]});
class Memory{constructor(){this.map=new Map()}getItem(k){return this.map.get(k)??null}setItem(k,v){this.map.set(k,v)}removeItem(k){this.map.delete(k)}}
function setup(localState=blank(),remoteState=null){
 const local=new Memory(),session=new Memory(),puts=[],backups=[],logins=[];let state=localState,remote={version:remoteState?1:0,data:remoteState},pause=null,readPause=null,fail=false;
 const sync=new GagebuSync.LedgerSync({local,session,getState:()=>state,applyRemote:x=>{state=structuredClone(x);return true},confirm:()=>true,backup:x=>backups.push(x),fetch:async(url,init)=>{
  if(fail)throw Error('offline');
  if(url.endsWith('/api/login')){logins.push(JSON.parse(init.body));return Response.json({token:'a'.repeat(64),expiresAt:Date.now()/1000+(logins.at(-1).remember?30*86400:12*3600)})}
  if(url.endsWith('/api/logout'))return Response.json({ok:true});
  if(init.method==='PUT'){
   const body=JSON.parse(init.body);puts.push(body);if(pause)await pause;
   if(body.version!==remote.version)return Response.json({serverVersion:remote.version},{status:409});
   remote={version:remote.version+1,data:body.data};return Response.json({ok:true,version:remote.version});
  }
  if(readPause)await readPause;
  return Response.json(remote);
 }});
 return {sync,local,session,puts,backups,logins,state:()=>state,edit:x=>{state=x;sync.localChanged()},remote:()=>remote,changeRemote:x=>{remote={version:remote.version+1,data:x}},pause:p=>{pause=p},pauseReads:p=>{readPause=p},offline:x=>{fail=x}};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
function pauseDigest(t,call){
 const entered=deferred(),released=deferred(),digest=webcrypto.subtle.digest.bind(webcrypto.subtle);let calls=0;
 t.mock.method(webcrypto.subtle,'digest',async(...args)=>{if(++calls===call){entered.resolve();await released.promise}return digest(...args)});
 return {entered:entered.promise,release:released.resolve};
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
test('edits during remote fingerprinting are automatically saved when the server is unchanged',async t=>{
 const f=setup(sample('a'));t.after(()=>clearTimeout(f.sync.timer));await f.sync.login('https://api.example','password');
 const paused=pauseDigest(t,2),checking=f.sync.start();await paused.entered;
 f.edit(sample('edited'));paused.release();await checking;
 assert.equal(f.state().records[0].id,'edited');assert.equal(f.remote().data.records[0].id,'edited');
 assert.equal(f.sync.meta.dirty,false);assert.equal(f.sync.status.kind,'saved');
});
test('edits while an adopted snapshot is fingerprinted remain pending',async t=>{
 const f=setup(blank(),sample('server'));t.after(()=>clearTimeout(f.sync.timer));
 const paused=pauseDigest(t,3),login=f.sync.login('https://api.example','password');await paused.entered;
 f.edit(sample('edited'));paused.release();await login;
 assert.equal(f.state().records[0].id,'edited');assert(f.sync.meta.dirty);assert.notEqual(f.sync.status.kind,'saved');
 await f.sync.flush();assert.equal(f.remote().data.records[0].id,'edited');
});
test('explicit pull blocks automatic writes and protects edits made during its read',async t=>{
 const f=setup(sample('a'));t.after(()=>clearTimeout(f.sync.timer));await f.sync.login('https://api.example','password');
 f.changeRemote(sample('other'));const paused=deferred();f.pauseReads(paused.promise);
 const pulling=f.sync.pull(),rejected=assert.rejects(pulling,/장부가 바뀌었습니다/);
 f.edit(sample('edited'));await f.sync.flush();const puts=f.puts.length;
 paused.resolve();await rejected;assert.equal(puts,1);
 assert.equal(f.state().records[0].id,'edited');assert.equal(f.remote().data.records[0].id,'other');assert(f.sync.meta.dirty);
});
test('remembered login reconnects in a new tab without sending the password again',async()=>{
 const f=setup(sample('a'));await f.sync.login('https://api.example','password');
 assert.equal(f.logins[0].remember,true);assert(f.local.getItem('gagebu-v2-session'));assert.equal(f.session.getItem('gagebu-v2-session'),null);
 const reopened=new GagebuSync.LedgerSync({...f.sync.options,session:new Memory()});await reopened.start();
 assert.equal(reopened.status.kind,'saved');assert.equal(f.logins.length,1);
 assert(![...f.local.map.values()].some(v=>v.includes('password')));
 await reopened.logout();assert.equal(f.local.getItem('gagebu-v2-session'),null);assert.equal(reopened.token,'');
 const loggedOut=new GagebuSync.LedgerSync({...f.sync.options,session:new Memory()});await loggedOut.start();assert.equal(loggedOut.status.kind,'login');
});
test('temporary sessions remain tab-only and expired remembered sessions cannot resume',async()=>{
 const f=setup(sample('a'));await f.sync.login('https://api.example','password',{remember:false});
 assert.equal(f.logins[0].remember,false);assert.equal(f.local.getItem('gagebu-v2-session'),null);assert(f.session.getItem('gagebu-v2-session'));
 const newTab=new GagebuSync.LedgerSync({...f.sync.options,session:new Memory()});assert.equal(newTab.token,'');
 await f.sync.logout();assert.equal(f.session.getItem('gagebu-v2-session'),null);
 f.local.setItem('gagebu-v2-session',JSON.stringify({url:'https://api.example',token:'a'.repeat(64),expiresAt:1}));
 const expired=new GagebuSync.LedgerSync({...f.sync.options,session:new Memory()});await expired.start();assert.equal(expired.status.kind,'login');assert.equal(expired.token,'');
});
