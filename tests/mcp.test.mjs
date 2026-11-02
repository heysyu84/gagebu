import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import {writeDocument,readDocument} from '../worker/storage.js';
import {callManagement} from '../worker/management.js';
import {pkce,random} from '../worker/mcp-oauth.js';
import {TestD1} from './helpers/d1.mjs';
const origin='https://manager.example',resource=origin+'/mcp';
const row=(id='a')=>({id,date:'2026-05-26',merchant:'검증용 쿠팡',amount:11820,direction:'expense',scope:'review',status:'review',ledgerType:'consumption',category:'온라인쇼핑',subcategory:'쿠팡',note:'보존할 메모'});
const blank=()=>({version:2,records:[row(),row('b')],refunds:[{id:'r',date:'2026-06-01',merchant:'검증용 환불',amount:2000,status:'review',refundOf:''}],dailyLotto:[],storeProfits:{}});
const owner={actor:'test-owner',scopes:['gagebu:read','gagebu:write']};
const expected=r=>({date:r.date,merchant:r.merchant,amount:r.amount});
async function setup(){const env={DB:new TestD1(),ADMIN_PASSWORD:'testpass',SESSION_PEPPER:'test-session-pepper-1234567890123456789'};await writeDocument(env.DB,0,blank());return env}
const request=(path,{method='GET',json,form,headers={}}={})=>new Request(origin+path,{method,headers:{...(json?{'Content-Type':'application/json'}:{}),...(form?{'Content-Type':'application/x-www-form-urlencoded'}:{}),...headers},...(json?{body:JSON.stringify(json)}:form?{body:new URLSearchParams(form).toString()}:{})});
async function register(env,extra={}){return worker.fetch(request('/oauth/register',{method:'POST',json:{client_name:'테스트 관리 앱',redirect_uris:['https://client.example/callback'],token_endpoint_auth_method:'none',...extra}}),env)}
async function authorization(env,{scope='gagebu:read gagebu:write',client,verifier=random(),headers={},password='testpass'}={}){
 client=client||await(await register(env)).json();
 const query=new URLSearchParams({client_id:client.client_id,redirect_uri:client.redirect_uris[0],response_type:'code',scope,resource,code_challenge_method:'S256',code_challenge:await pkce(verifier),state:'test-state'});
 const page=await worker.fetch(request('/oauth/authorize?'+query),env),html=await page.text(),flow=html.match(/name="flow" value="([^"]+)"/)?.[1],cookie=page.headers.get('set-cookie')?.split(';')[0];
 assert(flow);const approved=await worker.fetch(request('/oauth/authorize',{method:'POST',form:{flow,password,decision:'allow'},headers:{Origin:origin,Cookie:cookie,...headers}}),env);
 return {client,verifier,approved,flow,cookie};
}
async function token(env,auth,override={}){const code=new URL(auth.approved.headers.get('location')).searchParams.get('code');return worker.fetch(request('/oauth/token',{method:'POST',form:{grant_type:'authorization_code',client_id:auth.client.client_id,redirect_uri:auth.client.redirect_uris[0],resource,code,code_verifier:auth.verifier,...override}}),env)}
async function connected(env,scope){const auth=await authorization(env,{scope});assert.equal(auth.approved.status,302);return {auth,tokens:await(await token(env,auth)).json()}}
async function rpc(env,access,method,params={},headers={}){return worker.fetch(request('/mcp',{method:'POST',json:{jsonrpc:'2.0',id:'test-call',method,params},headers:{Authorization:'Bearer '+access,...headers}}),env)}
test('OAuth metadata, PKCE sign-in and both MCP protocol eras work without exposing the book',async()=>{
 const env=await setup();
 const unauthorized=await worker.fetch(request('/mcp',{method:'POST',json:{jsonrpc:'2.0',id:1,method:'tools/list'}}),env);assert.equal(unauthorized.status,401);assert.match(unauthorized.headers.get('www-authenticate'),/oauth-protected-resource/);
 const metadata=await(await worker.fetch(request('/.well-known/oauth-protected-resource/mcp'),env)).json();assert.equal(metadata.resource,resource);
 const {auth,tokens}=await connected(env);assert(tokens.access_token);assert(tokens.refresh_token);assert.equal(new URL(auth.approved.headers.get('location')).searchParams.get('state'),'test-state');
 const discovered=await(await rpc(env,tokens.access_token,'server/discover')).json();assert(discovered.result.supportedVersions.includes('2026-07-28'));
 const initialized=await(await rpc(env,tokens.access_token,'initialize',{protocolVersion:'2025-11-25'})).json();assert.equal(initialized.result.protocolVersion,'2025-11-25');
 const list=await(await rpc(env,tokens.access_token,'tools/list')).json();assert.equal(list.result.tools.length,6);assert(list.result.tools.every(t=>t.inputSchema.additionalProperties===false));
 const result=await(await rpc(env,tokens.access_token,'tools/call',{name:'sites_status',arguments:{}})).json();assert(!result.result.isError);assert.equal(JSON.parse(result.result.content[0].text).sites[0].version,1);
 const saved=env.DB.sql.prepare('SELECT * FROM mcp_tokens').get();assert.notEqual(saved.access_hash,tokens.access_token);assert.notEqual(saved.refresh_hash,tokens.refresh_token);
 assert.equal((await readDocument(env.DB)).version,1);
});
test('OAuth rejects bad redirect URIs, cross-origin approval, tampering and wrong PKCE',async()=>{
 const env=await setup();
 for(const uri of ['javascript:alert(1)','http://external.example/callback','https://client.example/callback#fragment'])assert.equal((await register(env,{redirect_uris:[uri]})).status,400);
 const badOrigin=await authorization(env,{headers:{Origin:'https://evil.example'}});assert.equal(badOrigin.approved.status,403);
 const good=await authorization(env);assert.equal(good.approved.status,302);
 assert.equal((await token(env,good,{code_verifier:'wrong'.repeat(12)})).status,400);
 assert.equal((await token(env,good)).status,200);assert.equal((await token(env,good)).status,400);
 const modified=good.flow.slice(0,-1)+(good.flow.endsWith('a')?'b':'a');
 const tampered=await worker.fetch(request('/oauth/authorize',{method:'POST',form:{flow:modified,password:'testpass',decision:'allow'},headers:{Origin:origin,Cookie:good.cookie}}),env);assert.equal(tampered.status,403);
});
test('read-only grants cannot write; wrong resource, expired and revoked access fail',async()=>{
 const env=await setup(),{auth,tokens}=await connected(env,'gagebu:read');
 const list=await(await rpc(env,tokens.access_token,'tools/list')).json();assert.equal(list.result.tools.length,3);
 const denied=await(await rpc(env,tokens.access_token,'tools/call',{name:'ledger_update_transaction',arguments:{}})).json();assert(denied.result.isError);
 const otherHost=await worker.fetch(new Request('https://another.example/mcp',{method:'POST',headers:{Authorization:'Bearer '+tokens.access_token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}),env);assert.equal(otherHost.status,401);
 env.DB.sql.prepare('UPDATE mcp_tokens SET access_expires=0').run();assert.equal((await rpc(env,tokens.access_token,'tools/list')).status,401);
 const fresh=await connected(env);await worker.fetch(request('/oauth/revoke',{method:'POST',form:{client_id:fresh.auth.client.client_id,token:fresh.tokens.access_token}}),env);
 assert.equal((await rpc(env,fresh.tokens.access_token,'tools/list')).status,401);assert.equal((await readDocument(env.DB)).version,1);
});
test('refresh tokens rotate, cannot broaden scopes, and reuse revokes their family',async()=>{
 const env=await setup(),{auth,tokens}=await connected(env,'gagebu:read');
 const refresh=override=>worker.fetch(request('/oauth/token',{method:'POST',form:{grant_type:'refresh_token',client_id:auth.client.client_id,resource,refresh_token:tokens.refresh_token,...override}}),env);
 assert.equal((await refresh({scope:'gagebu:read gagebu:write'})).status,400);
 const rotated=await(await refresh()).json();assert(rotated.access_token);assert.notEqual(rotated.refresh_token,tokens.refresh_token);
 assert.equal((await rpc(env,tokens.access_token,'tools/list')).status,401);
 assert.equal((await rpc(env,rotated.access_token,'tools/list')).status,200);
 assert.equal((await refresh()).status,400);assert.equal((await rpc(env,rotated.access_token,'tools/list')).status,401);
});
test('bounded searches do not return notes or the full ledger',async()=>{
 const env=await setup(),state=blank();state.records=Array.from({length:100},(_,i)=>({...row(String(i)),note:'큰 메모'.repeat(1000)}));await writeDocument(env.DB,1,state);
 const found=await callManagement('ledger_find',{merchant:'검증용',limit:2},env,owner);assert.equal(found.total,100);assert.equal(found.items.length,2);assert(found.nextOffset);assert(JSON.stringify(found).length<2000);assert(!JSON.stringify(found).includes('큰 메모'));
 await assert.rejects(callManagement('ledger_find',{limit:20000},env,owner));await assert.rejects(callManagement('ledger_find',{from:'2026-02-30'},env,owner));
 assert.equal((await readDocument(env.DB)).version,2);
});
test('batch transaction edits are atomic, keep unrelated fields and create durable undo receipts',async()=>{
 const env=await setup(),initial=await readDocument(env.DB);
 const edited=await callManagement('ledger_update_transaction',{expectedVersion:1,reason:'검증용 분류 수정',updates:[{id:'a',expected:expected(row()),changes:{scope:'business'}},{id:'b',expected:expected(row('b')),changes:{scope:'personal'}}]},env,owner);
 assert.equal(edited.version,2);assert.equal(edited.receipts.length,2);assert(edited.receipts.every(x=>x.verified));assert.equal(env.DB.sql.prepare('SELECT count(*) n FROM management_changes').get().n,2);
 const current=await readDocument(env.DB);assert.equal(current.data.records[0].amount,11820);assert.equal(current.data.records[0].note,'보존할 메모');assert.deepEqual(current.data.refunds,initial.data.refunds);
 current.data.records[0].note='나중에 추가한 메모';await writeDocument(env.DB,2,current.data);
 const undone=await callManagement('ledger_undo',{expectedVersion:3,changeId:edited.receipts[0].changeId,reason:'검증용 되돌리기'},env,owner);assert.equal(undone.version,4);assert(undone.receipts[0].verified);
 const after=await readDocument(env.DB);assert.equal(after.data.records[0].scope,'review');assert.equal(after.data.records[0].note,'나중에 추가한 메모');assert.equal(after.data.records[1].scope,'personal');
 const history=await callManagement('ledger_changes',{targetId:'a'},env,owner);assert(history.changes.some(x=>x.undoOf===edited.receipts[0].changeId));
});
test('stale versions, wrong identities and invalid batches never modify any record',async()=>{
 const env=await setup(),before=await readDocument(env.DB);
 const good={id:'a',expected:expected(row()),changes:{scope:'business'}};
 for(const input of [{expectedVersion:0,reason:'stale',updates:[good]},{expectedVersion:1,reason:'identity',updates:[{...good,expected:{...good.expected,amount:1}}]},{expectedVersion:1,reason:'partial',updates:[good,{id:'b',expected:expected(row('b')),changes:{amount:-1}}]}])await assert.rejects(callManagement('ledger_update_transaction',input,env,owner));
 assert.deepEqual(await readDocument(env.DB),before);assert.equal(env.DB.sql.prepare('SELECT count(*) n FROM management_changes').get().n,0);
});
test('undo refuses a later change to the same fields and supports older saved classification history',async()=>{
 const env=await setup();
 const updated=await callManagement('ledger_update_transaction',{expectedVersion:1,reason:'first',updates:[{id:'a',expected:expected(row()),changes:{scope:'business'}}]},env,owner);
 await callManagement('ledger_update_transaction',{expectedVersion:2,reason:'second',updates:[{id:'a',expected:expected(row()),changes:{scope:'personal'}}]},env,owner);
 await assert.rejects(callManagement('ledger_undo',{expectedVersion:3,changeId:updated.receipts[0].changeId,reason:'stale undo'},env,owner),/이후/);
 const saved=await readDocument(env.DB);saved.data.classificationHistory.push({id:'legacy-review',recordId:'a',...expected(row()),at:new Date().toISOString(),source:'legacy',fields:['scope'],before:{scope:'review'},after:{scope:'personal'}});await writeDocument(env.DB,3,saved.data);
 await callManagement('ledger_undo',{expectedVersion:4,changeId:'legacy-review',reason:'legacy undo'},env,owner);assert.equal((await readDocument(env.DB)).data.records[0].scope,'review');
});
test('refund linking preserves amounts and dates and can be undone independently',async()=>{
 const env=await setup();
 const r=blank().refunds[0],linked=await callManagement('ledger_manage_refund',{expectedVersion:1,id:'r',expected:expected(r),action:'link',purchaseId:'a',reason:'검증용 연결'},env,owner);
 const saved=await readDocument(env.DB);assert.equal(saved.data.refunds[0].refundOf,'a');assert.equal(saved.data.refunds[0].date,r.date);assert.equal(saved.data.refunds[0].amount,r.amount);assert.deepEqual(saved.data.records,blank().records);
 await callManagement('ledger_undo',{expectedVersion:2,changeId:linked.receipts[0].changeId,reason:'검증용 취소'},env,owner);assert.deepEqual((await readDocument(env.DB)).data.refunds,blank().refunds);
});
test('audit and financial save roll back together on D1 failure',async()=>{
 const env=await setup(),before=await readDocument(env.DB),batch=env.DB.batch.bind(env.DB);
 env.DB.batch=statements=>batch([...statements,env.DB.prepare('INSERT INTO missing_table VALUES(1)')]);
 await assert.rejects(callManagement('ledger_update_transaction',{expectedVersion:1,reason:'failure',updates:[{id:'a',expected:expected(row()),changes:{amount:100}}]},env,owner));
 assert.deepEqual(await readDocument(env.DB),before);assert.equal(env.DB.sql.prepare('SELECT count(*) n FROM management_changes').get().n,0);
});
test('only the website owner can list and terminate MCP connections without exposing credentials',async()=>{
 const env=await setup(),{tokens}=await connected(env);
 assert.equal((await worker.fetch(request('/api/mcp/connections'),env)).status,401);
 assert.equal((await worker.fetch(request('/api/mcp/connections',{headers:{Authorization:'Bearer '+tokens.access_token}}),env)).status,401);
 const login=await(await worker.fetch(request('/api/login',{method:'POST',json:{password:'testpass'}}),env)).json(),headers={Authorization:'Bearer '+login.token};
 const response=await worker.fetch(request('/api/mcp/connections',{headers}),env),text=await response.text(),connections=JSON.parse(text).connections;
 assert.equal(connections.length,1);assert(!text.includes(tokens.access_token));assert(!text.includes(tokens.refresh_token));assert(!text.includes('access_hash'));
 assert.equal((await worker.fetch(request('/api/mcp/connections/revoke',{method:'POST',headers,json:{id:connections[0].id}}),env)).status,200);
 assert.equal((await rpc(env,tokens.access_token,'tools/list')).status,401);
 assert.equal((await(await worker.fetch(request('/api/mcp/connections',{headers}),env)).json()).connections.length,0);
 assert.equal((await readDocument(env.DB)).version,1);
});
test('OAuth sign-in uses the existing password rate limit and never grants access on failure',async()=>{
 const env=await setup(),client=await(await register(env)).json();
 for(let i=0;i<6;i++){const a=await authorization(env,{client,password:'incorrect'});assert.equal(a.approved.status,401);assert(!a.approved.headers.get('location'));}
 const locked=await authorization(env,{client,password:'testpass'});assert.equal(locked.approved.status,429);
 assert.equal(env.DB.sql.prepare('SELECT count(*) n FROM mcp_codes').get().n,0);assert.equal(env.DB.sql.prepare('SELECT count(*) n FROM mcp_tokens').get().n,0);
});
test('expired codes and incorrect cookies cannot grant an MCP session',async()=>{
 const env=await setup(),bad=await authorization(env,{headers:{Cookie:'mcp_csrf=wrong'}});assert.equal(bad.approved.status,403);
 const auth=await authorization(env);env.DB.sql.prepare('UPDATE mcp_codes SET expires_at=0').run();assert.equal((await token(env,auth)).status,400);
 assert.equal(env.DB.sql.prepare('SELECT count(*) n FROM mcp_tokens').get().n,0);
});
