import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../worker/index.js';
import {writeDocument,readDocument} from '../worker/storage.js';
import '../ledger-validation.js';

const blank=()=>({version:2,records:[],refunds:[],dailyLotto:[],storeProfits:{}});
const record=(id='a')=>({id,date:'2026-11-02',amount:12500,direction:'expense',scope:'personal',status:'confirmed',merchant:'검증용 가게'});
class D1{
 constructor(){this.sql=new DatabaseSync(':memory:');this.sql.exec(readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8'))}
 prepare(query){
  const db=this.sql;let params=[];
  return {bind(...values){params=values;return this},async first(){return db.prepare(query).get(...params)??null},async all(){return {results:db.prepare(query).all(...params)}},async run(){const r=db.prepare(query).run(...params);return {meta:{changes:Number(r.changes)}}}};
 }
 async batch(statements){this.sql.exec('BEGIN');try{const out=[];for(const statement of statements)out.push(await statement.run());this.sql.exec('COMMIT');return out}catch(error){this.sql.exec('ROLLBACK');throw error}}
}
function request(path,method='GET',body,token){return new Request('https://ledger.example'+path,{method,headers:{Origin:'https://my-gagebu.pages.dev',...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})})}
test('strict dates, integer amounts and existing refund links',()=>{
 const state=blank();state.records.push(record());assert(GagebuValidation.validV2(state));
 assert(!GagebuValidation.date('2026-02-30'));assert(GagebuValidation.date('2028-02-29'));
 assert.equal(GagebuValidation.koreaDate('2026-11-01T16:00:00Z'),'2026-11-02');
 state.records[0].amount=1.5;assert(!GagebuValidation.validV2(state));state.records[0].amount=12500;
 state.refunds.push({id:'r',date:'2026-11-02',amount:500,status:'matched',refundOf:'absent'});assert(!GagebuValidation.validV2(state));
 state.refunds[0].refundOf='a';assert(GagebuValidation.validV2(state));
});
test('chunked round trip preserves large Korean data, emoji and all V2 settings',async()=>{
 const db=new D1(),state=blank();state.records.push({...record(),note:'한글 🐈'.repeat(60000)});state.taxonomy={fixed:{임대:['월세']}};
 assert.equal((await readDocument(db)).data,null);
 assert.equal((await writeDocument(db,0,state)).version,1);
 const saved=await readDocument(db);assert.deepEqual(saved.data,state);assert.equal(saved.version,1);
 assert(db.sql.prepare('SELECT count(*) AS n FROM ledger_document_chunks').get().n>2);
 assert.equal(db.sql.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='ledger_data'").get().n,0);
});
test('stale writers cannot alter document chunks or history',async()=>{
 const db=new D1(),first={...blank(),records:[record('first')]},second={...blank(),records:[record('second')]};
 await writeDocument(db,0,first);
 assert.equal((await writeDocument(db,0,second)).conflict,true);
 assert.deepEqual((await readDocument(db)).data,first);
 assert.equal(db.sql.prepare('SELECT count(*) AS n FROM ledger_document_history').get().n,1);
});
test('only 10 revisions are retained, with the active revision intact',async()=>{
 const db=new D1();for(let version=0;version<13;version++)await writeDocument(db,version,{...blank(),records:[{...record(),amount:version}]});
 assert.equal(db.sql.prepare('SELECT count(*) AS n FROM ledger_document_history').get().n,10);
 assert.equal(db.sql.prepare('SELECT count(distinct revision) AS n FROM ledger_document_chunks').get().n,10);
 assert.equal((await readDocument(db)).data.records[0].amount,12);
});
test('D1 batch failure rolls back CAS and partial chunk writes',async()=>{
 const db=new D1();await writeDocument(db,0,blank());const batch=db.batch.bind(db);
 db.batch=statements=>batch([...statements,db.prepare('INSERT INTO missing_table VALUES(1)')]);
 await assert.rejects(writeDocument(db,1,{...blank(),records:[record()]}));
 assert.equal((await readDocument(db)).version,1);assert.deepEqual((await readDocument(db)).data,blank());
});
test('API login, V2 write/read, CAS conflict, logout and origin protection',async()=>{
 const env={DB:new D1(),ADMIN_PASSWORD:'test-password-123456789',SESSION_PEPPER:'test-pepper-123456789123456789123456789'};
 assert.equal((await worker.fetch(request('/api/v2/state'),env)).status,401);
 const login=await worker.fetch(request('/api/login','POST',{password:env.ADMIN_PASSWORD}),env),{token}=await login.json();assert(token);
 const state={...blank(),records:[record()]};
 assert.equal((await worker.fetch(request('/api/v2/state','PUT',{version:0,data:state},token),env)).status,200);
 assert.deepEqual((await (await worker.fetch(request('/api/v2/state','GET',null,token),env)).json()).data,state);
 assert.equal((await worker.fetch(request('/api/v2/state','PUT',{version:0,data:state},token),env)).status,409);
 state.records[0].amount=-1;assert.equal((await worker.fetch(request('/api/v2/state','PUT',{version:1,data:state},token),env)).status,400);
 assert.equal((await worker.fetch(new Request('https://ledger.example/health',{headers:{Origin:'https://other.example'}}),env)).status,403);
 assert.equal((await worker.fetch(request('/api/logout','POST',{},token),env)).status,200);
 assert.equal((await worker.fetch(request('/api/v2/state','GET',null,token),env)).status,401);
});
test('health does not report success when storage/auth is missing',async()=>{
 assert.equal((await worker.fetch(request('/health'),{})).status,503);
});
