const enc=new TextEncoder(),now=()=>Math.floor(Date.now()/1000);
export const SCOPES=['gagebu:read','gagebu:write'];
const html=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const unb64=value=>Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),x=>x.charCodeAt(0));
export const random=()=>b64(crypto.getRandomValues(new Uint8Array(32)));
export const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value))),n=>n.toString(16).padStart(2,'0')).join('');
export const pkce=async value=>b64(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value))));
const equal=(a,b)=>{let n=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)n|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return n===0};
const mac=async(secret,value)=>{
 const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return b64(new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode('mcp-flow:'+value))));
};
const signed=async(secret,value)=>{const raw=b64(enc.encode(JSON.stringify(value)));return raw+'.'+await mac(secret,raw)};
async function openSigned(secret,value){
 const [raw,signature,...extra]=String(value||'').split('.');
 if(!raw||!signature||extra.length||!equal(await mac(secret,raw),signature))return null;
 try{return JSON.parse(new TextDecoder().decode(unb64(raw)))}catch{return null}
}
export const oauthJSON=(status,body,headers={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',...headers}});
const error=(message='invalid_request',status=400)=>oauthJSON(status,{error:message});
async function jsonBody(req){
 if(!String(req.headers.get('content-type')).startsWith('application/json'))throw Error('invalid_request');
 const body=await req.text();if(enc.encode(body).length>32768)throw Error('invalid_request');return JSON.parse(body);
}
async function formBody(req){
 if(!String(req.headers.get('content-type')).startsWith('application/x-www-form-urlencoded'))throw Error('invalid_request');
 const raw=await req.text();if(enc.encode(raw).length>32768)throw Error('invalid_request');
 const form=new URLSearchParams(raw);for(const key of new Set(form.keys()))if(form.getAll(key).length!==1)throw Error('invalid_request');return form;
}
function validRedirect(value){
 try{const u=new URL(value);return value.length<2048&&!u.username&&!u.password&&!u.hash&&(u.protocol==='https:'||u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname))}catch{return false}
}
function scopes(value){
 const all=String(value||'gagebu:read').split(/\s+/).filter(Boolean);
 return all.length&&all.every(x=>SCOPES.includes(x))&&all.includes('gagebu:read')?[...new Set(all)].sort().join(' '):null;
}
const resource=req=>new URL(req.url).origin+'/mcp';
const client=async(env,id)=>typeof id==='string'&&id.length<200?env.DB.prepare('SELECT * FROM mcp_clients WHERE client_id=?').bind(id).first():null;
function page(title,body,headers={},status=200){
 return new Response('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+html(title)+'</title><style>body{font:16px/1.6 system-ui;margin:0;background:#eef3f2;color:#18352d}main{max-width:620px;margin:7vh auto;padding:28px;background:white;border-radius:18px}h1{font-size:25px}label{display:grid;gap:7px}input,button{font:inherit;padding:12px;border-radius:8px;border:1px solid #bccbc5}button{cursor:pointer}button[value=allow]{background:#17634e;color:white}form>div{display:flex;gap:10px;margin-top:18px}small{overflow-wrap:anywhere;color:#51675e}a{color:#17634e}code{overflow-wrap:anywhere}li{margin:8px 0}</style><main><h1>'+html(title)+'</h1>'+body+'</main></html>',{status,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",...headers}});
}
export async function verifyMcpToken(req,env){
 const match=(req.headers.get('authorization')||'').match(/^Bearer ([A-Za-z0-9_-]{43})$/);if(!match)return null;
 const row=await env.DB.prepare('SELECT * FROM mcp_tokens WHERE access_hash=? AND revoked=0 AND access_expires>? AND resource=?').bind(await hash('access:'+match[1]),now(),resource(req)).first();
 return row?{actor:'mcp:'+row.client_id,scopes:row.scope.split(' '),clientId:row.client_id}:null;
}
async function createTokens(env,{clientId,uri,scope}){
 const access=random(),refresh=random(),time=now();
 await env.DB.batch([env.DB.prepare('DELETE FROM mcp_codes WHERE expires_at<=?').bind(time),env.DB.prepare('DELETE FROM mcp_tokens WHERE refresh_expires<=?').bind(time),env.DB.prepare('DELETE FROM mcp_used_refresh WHERE expires_at<=?').bind(time),env.DB.prepare('DELETE FROM mcp_public_limits WHERE window_start<?').bind(Math.floor(time/3600)-24)]);
 await env.DB.prepare('INSERT INTO mcp_tokens(access_hash,refresh_hash,family_id,client_id,resource,scope,access_expires,refresh_expires) VALUES(?,?,?,?,?,?,?,?)').bind(await hash('access:'+access),await hash('refresh:'+refresh),crypto.randomUUID(),clientId,uri,scope,time+3600,time+30*86400).run();
 return {access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:3600,scope};
}
export async function handleOAuth(req,env,passwordCheck){
 const url=new URL(req.url),origin=url.origin,path=url.pathname,uri=resource(req);
 if(path==='/manage'&&req.method==='GET')return page('개인 사이트 관리 연결','<p>가계부 관리 도구를 MCP 지원 AI에 연결할 수 있습니다. 사이트의 일반 입력·수정·저장은 AI 연결 없이도 사용할 수 있습니다.</p><p><b>MCP 서버 주소</b><br><code>'+html(uri)+'</code></p><p>연결 방식은 OAuth입니다. 로그인 화면에서는 기존 가계부 관리자 비밀번호를 사용합니다.</p><ul><li>가계부: 거래 검색·일괄 수정·환불 관리·이력·되돌리기</li><li>풍월관·클전: 아직 연결되지 않았습니다.</li></ul><p>조회 권한으로 먼저 연결하거나, 수정 권한을 함께 허용할 수 있습니다.</p>');
 if(path==='/.well-known/oauth-protected-resource'||path==='/.well-known/oauth-protected-resource/mcp')return oauthJSON(200,{resource:uri,authorization_servers:[origin],scopes_supported:SCOPES,resource_name:'개인 사이트 관리',resource_documentation:origin+'/manage'});
 if(path==='/.well-known/oauth-authorization-server')return oauthJSON(200,{issuer:origin,authorization_endpoint:origin+'/oauth/authorize',token_endpoint:origin+'/oauth/token',registration_endpoint:origin+'/oauth/register',revocation_endpoint:origin+'/oauth/revoke',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],scopes_supported:SCOPES,authorization_response_iss_parameter_supported:true});
 if(!path.startsWith('/oauth/'))return null;
 if(!env.DB||!env.SESSION_PEPPER||!env.ADMIN_PASSWORD)return error('temporarily_unavailable',503);
 try{
  if(path==='/oauth/register'&&req.method==='POST'){
   const bucket=await hash('registration:'+(req.headers.get('CF-Connecting-IP')||'unknown')),window=Math.floor(now()/3600);
   await env.DB.prepare('INSERT INTO mcp_public_limits(bucket,window_start,count) VALUES(?,?,1) ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN window_start=excluded.window_start THEN count+1 ELSE 1 END,window_start=excluded.window_start').bind(bucket,window).run();
   const rate=await env.DB.prepare('SELECT count FROM mcp_public_limits WHERE bucket=?').bind(bucket).first();if(rate.count>20)return error('slow_down',429);
   const input=await jsonBody(req);
   if(!Array.isArray(input.redirect_uris)||input.redirect_uris.length<1||input.redirect_uris.length>10||!input.redirect_uris.every(x=>typeof x==='string'&&validRedirect(x))||input.token_endpoint_auth_method&&input.token_endpoint_auth_method!=='none'||input.grant_types&&(!Array.isArray(input.grant_types)||!input.grant_types.every(x=>['authorization_code','refresh_token'].includes(x)))||input.response_types&&(!Array.isArray(input.response_types)||input.response_types.some(x=>x!=='code')))return error('invalid_client_metadata');
   const id=crypto.randomUUID(),name=typeof input.client_name==='string'?input.client_name.slice(0,100):'MCP client';
   await env.DB.prepare('INSERT INTO mcp_clients(client_id,client_name,redirect_uris,created_at) VALUES(?,?,?,?)').bind(id,name,JSON.stringify([...new Set(input.redirect_uris)]),now()).run();
   return oauthJSON(201,{client_id:id,client_name:name,redirect_uris:input.redirect_uris,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],client_id_issued_at:now()});
  }
  if(path==='/oauth/authorize'&&req.method==='GET'){
   const q=url.searchParams,c=await client(env,q.get('client_id')),scope=scopes(q.get('scope')),redirect=q.get('redirect_uri'),challenge=q.get('code_challenge');
   if(!c||!JSON.parse(c.redirect_uris).includes(redirect)||q.get('response_type')!=='code'||q.get('resource')!==uri||q.get('code_challenge_method')!=='S256'||!/^[A-Za-z0-9_-]{43}$/.test(challenge||'')||!scope||String(q.get('state')||'').length>2000)return error();
   const nonce=random(),flow=await signed(env.SESSION_PEPPER,{client:c.client_id,redirect,scope,challenge,state:q.get('state')||'',uri,nonce,exp:now()+600});
   return page('관리 도구 연결 허용','<p><b>'+html(c.client_name)+'</b>에서 가계부에 연결하려고 합니다.</p><p><small>연결 앱 주소: '+html(new URL(redirect).origin)+'</small></p><ul><li>가계부 거래·환불·변경 이력 조회</li>'+(scope.includes('gagebu:write')?'<li><b>거래 수정·환불 연결 및 제외·변경 되돌리기</b></li>':'')+'</ul><p>풍월관·클전 자료에는 접근하지 않습니다.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="flow" value="'+html(flow)+'"><label>가계부 관리자 비밀번호<input name="password" type="password" autocomplete="current-password" required maxlength="20000"></label><div><button name="decision" value="allow">로그인하고 연결 허용</button><button name="decision" value="deny" formnovalidate>취소</button></div></form>',{'Set-Cookie':'mcp_csrf='+nonce+'; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600'});
  }
  if(path==='/oauth/authorize'&&req.method==='POST'){
   if(req.headers.get('origin')!==origin)return error('invalid_request',403);
   const f=await formBody(req),flow=await openSigned(env.SESSION_PEPPER,f.get('flow'));
   const cookie=(req.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('mcp_csrf='))?.slice(9);
   if(!flow||flow.exp<now()||flow.uri!==uri||!cookie||!equal(flow.nonce,cookie))return error('invalid_request',403);
   const c=await client(env,flow.client);if(!c||!JSON.parse(c.redirect_uris).includes(flow.redirect))return error('invalid_client');
   const redirect=new URL(flow.redirect);redirect.searchParams.set('state',flow.state);redirect.searchParams.set('iss',origin);
   if(f.get('decision')!=='allow'){redirect.searchParams.set('error','access_denied');return new Response(null,{status:302,headers:{Location:redirect.href,'Cache-Control':'no-store'}})}
   const accepted=await passwordCheck(req,env,String(f.get('password')||''));
   if(accepted.status!==200){
    const retry=new URLSearchParams({client_id:flow.client,redirect_uri:flow.redirect,response_type:'code',resource:flow.uri,scope:flow.scope,code_challenge_method:'S256',code_challenge:flow.challenge,state:flow.state});
    return page('연결하지 못했습니다.','<p>'+(accepted.status===429?'로그인 시도가 많습니다. 15분 뒤 다시 시도하세요.':'관리자 비밀번호를 확인해 주세요.')+'</p><a href="/oauth/authorize?'+html(retry.toString())+'">로그인 다시 시도</a>',{},accepted.status);
   }
   const code=random();await env.DB.prepare('INSERT INTO mcp_codes(code_hash,client_id,redirect_uri,resource,scope,challenge,expires_at) VALUES(?,?,?,?,?,?,?)').bind(await hash('code:'+code),flow.client,flow.redirect,flow.uri,flow.scope,flow.challenge,now()+120).run();
   redirect.searchParams.set('code',code);
   return new Response(null,{status:302,headers:{Location:redirect.href,'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Set-Cookie':'mcp_csrf=; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0'}});
  }
  if(path==='/oauth/token'&&req.method==='POST'){
   const f=await formBody(req),c=await client(env,f.get('client_id'));if(!c)return error('invalid_client');
   if(f.get('resource')!==uri)return error('invalid_target');
   if(f.get('grant_type')==='authorization_code'){
    const codeHash=await hash('code:'+String(f.get('code')||'')),row=await env.DB.prepare('SELECT * FROM mcp_codes WHERE code_hash=?').bind(codeHash).first(),verifier=f.get('code_verifier')||'';
    if(!row||row.expires_at<=now()||row.client_id!==c.client_id||row.redirect_uri!==f.get('redirect_uri')||row.resource!==uri||!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)||!equal(row.challenge,await pkce(verifier)))return error('invalid_grant');
    const consumed=await env.DB.prepare('DELETE FROM mcp_codes WHERE code_hash=?').bind(codeHash).run();if(consumed.meta.changes!==1)return error('invalid_grant');
    return oauthJSON(200,await createTokens(env,{clientId:c.client_id,uri,scope:row.scope}));
   }
   if(f.get('grant_type')==='refresh_token'){
    const oldHash=await hash('refresh:'+String(f.get('refresh_token')||'')),row=await env.DB.prepare('SELECT * FROM mcp_tokens WHERE refresh_hash=?').bind(oldHash).first();
    if(!row){const used=await env.DB.prepare('SELECT family_id FROM mcp_used_refresh WHERE refresh_hash=?').bind(oldHash).first();if(used)await env.DB.prepare('UPDATE mcp_tokens SET revoked=1 WHERE family_id=? AND client_id=?').bind(used.family_id,c.client_id).run();return error('invalid_grant')}
    const scope=f.has('scope')?scopes(f.get('scope')):row.scope;
    if(row.revoked||row.client_id!==c.client_id||row.resource!==uri||row.refresh_expires<=now()||!scope||scope.split(' ').some(x=>!row.scope.split(' ').includes(x)))return error('invalid_grant');
    const access=random(),refresh=random(),newHash=await hash('refresh:'+refresh);
    const result=await env.DB.batch([
     env.DB.prepare('UPDATE mcp_tokens SET access_hash=?,refresh_hash=?,access_expires=?,scope=? WHERE refresh_hash=? AND revoked=0').bind(await hash('access:'+access),newHash,now()+3600,scope,oldHash),
     env.DB.prepare('INSERT INTO mcp_used_refresh(refresh_hash,family_id,expires_at) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM mcp_tokens WHERE refresh_hash=?)').bind(oldHash,row.family_id,row.refresh_expires,newHash)
    ]);
    if(result[0].meta.changes!==1)return error('invalid_grant');
    return oauthJSON(200,{access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:3600,scope});
   }
   return error('unsupported_grant_type');
  }
  if(path==='/oauth/revoke'&&req.method==='POST'){
   const f=await formBody(req),id=f.get('client_id'),token=f.get('token')||'';
   if(!await client(env,id))return error('invalid_client');
   await env.DB.prepare('UPDATE mcp_tokens SET revoked=1 WHERE client_id=? AND (access_hash=? OR refresh_hash=?)').bind(id,await hash('access:'+token),await hash('refresh:'+token)).run();
   return oauthJSON(200,{});
  }
  return error('invalid_request',405);
 }catch(error){return oauthJSON(400,{error:'invalid_request'})}
}
