/* Browser-local commits remain usable offline. Remote writes use a version lease.
 * Passwords are never persisted; bearer sessions live only in this tab. */
(function(root){
'use strict';
const CONFIG='gagebu-v2-api',SESSION='gagebu-v2-session',META='gagebu-v2-sync:';
const safeRead=(storage,key,fallback)=>{try{return JSON.parse(storage.getItem(key)||'null')??fallback}catch{return fallback}};
const fingerprint=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('');
class LedgerSync{
 constructor(options){
  this.options=options;this.local=options.local||localStorage;this.session=options.session||sessionStorage;
  this.fetch=options.fetch||root.fetch.bind(root);this.timer=null;this.flight=null;this.reconciling=null;this.reading=false;this.stopped=false;this.remote=null;
  this.url='';this.token='';this.meta={};this.status={kind:'local',label:'이 브라우저에 저장됨'};
  try{this.url=this.local.getItem(CONFIG)||root.GAGEBU_CONFIG?.apiBase||''}catch{}
  const saved=safeRead(this.session,SESSION,{});
  if(saved.url===this.url&&saved.expiresAt>Date.now()/1000)this.token=saved.token||'';
  this.meta=safeRead(this.local,META+this.url,{});
 }
 notify(kind,label){this.status={kind,label};this.options.onStatus?.(this.status)}
 storeMeta(){try{this.local.setItem(META+this.url,JSON.stringify(this.meta))}catch{}}
 clearSession(){this.token='';try{this.session.removeItem(SESSION)}catch{}}
 async request(path,{body,method='GET'}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
   const response=await this.fetch(this.url+path,{method,signal:controller.signal,cache:'no-store',credentials:'omit',headers:{...(this.token?{Authorization:'Bearer '+this.token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
   let result;try{result=await response.json()}catch{throw Error('서버 응답이 JSON 형식이 아닙니다. API 주소를 확인하세요.')}
   if(!response.ok){const error=Error(response.status===401?'로그인이 필요합니다.':response.status===409?'다른 기기에서 자료가 바뀌었습니다.':response.status===429?'로그인 시도가 많습니다. 15분 뒤 다시 시도하세요.':response.status===503?'서버의 데이터베이스·비밀번호 설정을 확인하세요.':response.status===400?'장부 형식을 확인하세요. 로컬 자료는 유지됩니다.':'서버 요청 실패 ('+response.status+')');error.status=response.status;error.result=result;throw error}
   return result;
  }finally{clearTimeout(timer)}
 }
 error(error){
  if(error.status===401){this.clearSession();this.notify('login','서버 로그인 필요 · 로컬 보관')}
  else if(error.status===409){this.stopped=true;this.notify('conflict','기기 간 변경 충돌 · 확인 필요')}
  else this.notify('error','서버 미저장 · 로컬 보관');
  this.options.onError?.(error);
 }
 localChanged(){
  this.meta.dirty=true;this.storeMeta();
  if(!this.url){this.notify('local','이 브라우저에 저장됨');return}
  if(this.stopped)return;
  if(!this.token){this.notify('login','서버 로그인 필요 · 로컬 보관');return}
  this.notify('pending','로컬 저장됨 · 서버 저장 대기');this.schedule();
 }
 schedule(){clearTimeout(this.timer);this.timer=setTimeout(()=>{this.timer=null;void this.flush()},650)}
 async start(){
  if(!this.url){this.notify('local','이 브라우저에 저장됨');return}
  if(!this.token){this.notify('login','서버 로그인 필요 · 로컬 보관');return}
  try{await this.reconcile()}catch(error){this.error(error)}
 }
 async login(url,password){
  const parsed=new URL(url);
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash||!['','/'].includes(parsed.pathname))throw Error('경로·비밀번호가 없는 HTTPS API 주소를 입력하세요.');
  if(this.flight)throw Error('진행 중인 저장이 끝난 후 다시 연결하세요.');
  this.clearSession();this.url=parsed.origin;this.stopped=false;
  this.meta=safeRead(this.local,META+this.url,{});
  const login=await this.request('/api/login',{method:'POST',body:{password}});
  if(!/^[a-f0-9]{64}$/.test(login.token)||!Number.isFinite(login.expiresAt))throw Error('로그인 응답을 확인하세요.');
  this.token=login.token;
  try{this.local.setItem(CONFIG,this.url);this.session.setItem(SESSION,JSON.stringify({url:this.url,token:login.token,expiresAt:login.expiresAt}))}catch{}
  try{await this.reconcile()}catch(error){this.error(error);throw error}
 }
 async getRemote(){
  const remote=await this.request('/api/v2/state');
  if(!Number.isSafeInteger(remote.version)||remote.version<0||(remote.data!==null&&!root.GagebuValidation.validV2(remote.data)))throw Error('서버 장부 형식을 확인하세요.');
  this.remote=remote;return remote;
 }
 async adopt(remote){
  if(!remote.data)throw Error('서버에 저장된 장부가 없습니다.');
  if(!this.options.applyRemote(remote.data))throw Error('브라우저에 저장할 공간이 부족합니다. 기존 자료를 유지했습니다.');
  this.meta={version:remote.version,dirty:false,syncedHash:await fingerprint(JSON.stringify(this.options.getState())),lastSyncedAt:new Date().toISOString()};
  this.stopped=false;this.storeMeta();this.notify('saved','서버 저장 확인됨');
 }
 async reconcile(){
  if(this.reconciling)return this.reconciling;
  this.reconciling=this.reconcileOnce();
  try{await this.reconciling}finally{this.reconciling=null}
 }
 async reconcileOnce(){
  if(this.flight)await this.flight;
  clearTimeout(this.timer);
  this.notify('pending','서버 자료 확인 중');
  const localBefore=JSON.stringify(this.options.getState());
  let remote;this.reading=true;
  try{remote=await this.getRemote()}finally{this.reading=false}
  const localRaw=JSON.stringify(this.options.getState()),hash=await fingerprint(localRaw);
  // A user may edit while the first GET is in flight. Never replace those edits.
  if(localRaw!==localBefore){this.stopped=true;this.notify('conflict','확인 중 로컬 변경 · 자료 비교 필요');return}
  if(remote.data&&await fingerprint(JSON.stringify(remote.data))===hash){
   this.meta={version:remote.version,dirty:false,syncedHash:hash,lastSyncedAt:new Date().toISOString()};this.storeMeta();this.stopped=false;this.notify('saved','서버 저장 확인됨');return;
  }
  if(remote.version===0&&!remote.data){this.meta.version=0;this.meta.dirty=true;this.stopped=false;await this.flush();return}
  if(this.meta.dirty&&this.meta.version===remote.version){this.stopped=false;await this.flush();return}
  if(!this.meta.dirty&&((this.meta.syncedHash&&this.meta.syncedHash===hash)||(!this.meta.syncedHash&&root.GagebuValidation.empty(this.options.getState())))){
   await this.adopt(remote);return;
  }
  this.stopped=true;this.notify('conflict','기기 간 변경 충돌 · 확인 필요');
 }
 async flush(){
  if(this.flight)return this.flight;
  if(!this.url||!this.token||this.stopped||this.reading||!this.meta.dirty||!Number.isSafeInteger(this.meta.version))return;
  this.flight=this.send();
  try{await this.flight}catch(error){this.error(error)}finally{this.flight=null}
 }
 async send(){
  const raw=JSON.stringify(this.options.getState()),version=this.meta.version;
  this.notify('pending','서버에 저장 중');
  const result=await this.request('/api/v2/state',{method:'PUT',body:{version,data:JSON.parse(raw)}});
  if(result.version!==version+1)throw Error('저장 버전 응답을 확인하세요.');
  this.meta.version=result.version;this.meta.syncedHash=await fingerprint(raw);this.meta.lastSyncedAt=new Date().toISOString();
  this.meta.dirty=JSON.stringify(this.options.getState())!==raw;this.storeMeta();
  if(this.meta.dirty){this.notify('pending','추가 변경 저장 대기');this.schedule()}
  else this.notify('saved','서버 저장 확인됨');
 }
 async pull(){
  if(this.flight||this.reconciling||this.reading)throw Error('진행 중인 저장·연결 확인이 끝난 후 다시 시도하세요.');
  const before=JSON.stringify(this.options.getState()),remote=await this.getRemote();
  if(!remote.data)throw Error('서버에 저장된 장부가 없습니다.');
  if(before!==JSON.stringify(this.options.getState()))throw Error('확인 중 장부가 바뀌었습니다. 다시 시도하세요.');
  if(before!==JSON.stringify(remote.data)){
   if(!this.options.confirm('서버 자료로 이 기기의 장부를 바꿀까요?\n현재 장부를 JSON으로 먼저 백업합니다. 서버 자료는 변경하지 않습니다.'))return;
   this.options.backup(this.options.getState(),'서버불러오기전');
  }
  await this.adopt(remote);
 }
 async push(){
  if(this.flight||this.reconciling||this.reading)throw Error('진행 중인 저장·연결 확인이 끝난 후 다시 시도하세요.');
  const raw=JSON.stringify(this.options.getState()),remote=await this.getRemote();
  if(raw!==JSON.stringify(this.options.getState()))throw Error('확인 중 장부가 바뀌었습니다. 다시 시도하세요.');
  if(remote.data&&JSON.stringify(remote.data)!==raw){
   if(!this.options.confirm('현재 장부로 서버 자료를 갱신할까요?\n다른 기기의 변경이 덮어써질 수 있습니다. 현재 서버 자료를 JSON으로 먼저 백업합니다.'))return;
   this.options.backup(remote.data,'서버갱신전');
  }
  this.meta.version=remote.version;this.meta.dirty=true;this.stopped=false;this.storeMeta();await this.flush();
 }
 async logout(){
  clearTimeout(this.timer);
  if(this.reconciling)await this.reconciling.catch(()=>{});
  if(this.flight)await this.flight.catch(()=>{});
  try{if(this.token)await this.request('/api/logout',{method:'POST'})}finally{this.clearSession();this.notify('login','서버 로그아웃 · 로컬 보관')}
 }
}
root.GagebuSync={LedgerSync,fingerprint};
})(globalThis);
