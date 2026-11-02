/**
 * STORE LEDGER private API (Cloudflare Worker + D1).
 * No personal ledger data or passwords belong in GitHub or published website files.
 * ADMIN_PASSWORD and SESSION_PEPPER must be set with `wrangler secret put`.
 */
import '../ledger-validation.js';
import {readDocument,writeDocument,listDocumentHistory,readDocumentVersion} from './storage.js';
const SESSION_SECONDS=12*60*60;
const MAX_BODY_BYTES=4*1024*1024;
const text = (status,message,origin,extras={})=>reply(status,{error:message},origin,extras);
const reply=(status,payload,origin,extras={})=>new Response(JSON.stringify(payload),{
  status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Vary':'Origin',...(origin?{'Access-Control-Allow-Origin':origin}:{}),...extras}
});
const now=()=>Math.floor(Date.now()/1000);
const enc=new TextEncoder();
const digest=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(s)))].map(x=>x.toString(16).padStart(2,'0')).join('');
const equal=(a,b)=>{
  const x=enc.encode(String(a)),y=enc.encode(String(b));
  let mismatch=x.length^y.length;
  for(let i=0;i<Math.max(x.length,y.length);i++)mismatch|=(x[i]||0)^(y[i]||0);
  return mismatch===0;
};
const createToken=()=>[...crypto.getRandomValues(new Uint8Array(32))].map(x=>x.toString(16).padStart(2,'0')).join('');
const readJson=async req=>{
  if(!String(req.headers.get('content-type')||'').startsWith('application/json'))throw Error('JSON Content-Type required');
  if(+(req.headers.get('content-length')||0)>MAX_BODY_BYTES)throw Error('Request exceeds 4 MB');
  const raw=await req.text();if(enc.encode(raw).length>MAX_BODY_BYTES)throw Error('Request exceeds 4 MB');return JSON.parse(raw);
};
const getToken=req=>{
  const auth=req.headers.get('authorization')||'';
  const m=auth.match(/^Bearer ([0-9a-f]{64})$/);return m?.[1]||null;
};
const verify=async(req,env)=>{
  const token=getToken(req);if(!token)return false;
  const hash=await digest(`${env.SESSION_PEPPER}:${token}`);
  const session=await env.DB.prepare('SELECT expires_at FROM ledger_sessions WHERE token_hash = ?').bind(hash).first();
  return !!session&&Number(session.expires_at)>now();
};
const failRate=async(req,env)=>{
  const ip=req.headers.get('CF-Connecting-IP')||'unknown';
  const hash=await digest(`${env.SESSION_PEPPER}:${ip}`);
  const attempt=await env.DB.prepare('SELECT fail_count,reset_at FROM auth_attempts WHERE ip_hash = ?').bind(hash).first();
  return {hash,attempt:attempt&&attempt.reset_at>now()?attempt:null};
};
export default {
  async fetch(req,env){
    const url=new URL(req.url),path=url.pathname,origin=req.headers.get('origin')||'';
    const allowed=new Set(String(env.ALLOWED_ORIGINS||'https://my-gagebu.pages.dev,https://heysyu84.github.io').split(',').map(s=>s.trim()).filter(Boolean));
    if(origin&&!allowed.has(origin))return text(403,'Origin not allowed',null);
    if(req.method==='OPTIONS')return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET, POST, PUT, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Max-Age':'600','Vary':'Origin'}});
    if(!env.DB||!env.ADMIN_PASSWORD||!env.SESSION_PEPPER)return text(503,'Server setup incomplete',origin);
    try{
      if(path==='/health'&&req.method==='GET'){
        const document=await env.DB.prepare("SELECT version FROM ledger_documents WHERE ledger_key='main-v2'").first();
        if(!document||!Number.isSafeInteger(document.version))throw Error('Document schema incomplete');
        return reply(200,{ok:true,service:'store-ledger-api',schemas:[2]},origin);
      }
      if(path==='/api/login'&&req.method==='POST'){
        const {hash,attempt}=await failRate(req,env);
        if(attempt?.fail_count>=6)return text(429,'Too many attempts, retry after 15 minutes',origin);
        const body=await readJson(req);
        const password=String(body.password||'');
        if(!equal(await digest(password),await digest(env.ADMIN_PASSWORD))){
          await env.DB.prepare(`INSERT INTO auth_attempts(ip_hash,fail_count,reset_at) VALUES(?,1,?) ON CONFLICT(ip_hash) DO UPDATE SET fail_count=CASE WHEN reset_at<? THEN 1 ELSE fail_count+1 END, reset_at=CASE WHEN reset_at<? THEN excluded.reset_at ELSE reset_at END`).bind(hash,now()+900,now(),now()).run();
          return text(401,'Incorrect password',origin);
        }
        await env.DB.prepare('DELETE FROM auth_attempts WHERE ip_hash = ?').bind(hash).run();
        const token=createToken();
        await env.DB.prepare('DELETE FROM ledger_sessions WHERE expires_at <= ?').bind(now()).run();
        await env.DB.prepare('DELETE FROM auth_attempts WHERE reset_at <= ?').bind(now()).run();
        await env.DB.prepare('INSERT INTO ledger_sessions(token_hash,created_at,expires_at) VALUES(?,?,?)').bind(await digest(`${env.SESSION_PEPPER}:${token}`),now(),now()+SESSION_SECONDS).run();
        return reply(200,{token,expiresAt:now()+SESSION_SECONDS},origin);
      }
      if(!path.startsWith('/api/'))return text(404,'Not found',origin);
      if(!await verify(req,env))return text(401,'Login required',origin);
      if(path==='/api/logout'&&req.method==='POST'){
        const token=getToken(req);await env.DB.prepare('DELETE FROM ledger_sessions WHERE token_hash = ?').bind(await digest(`${env.SESSION_PEPPER}:${token}`)).run();
        return reply(200,{ok:true},origin);
      }
      if(path==='/api/v2/state'&&req.method==='GET')return reply(200,await readDocument(env.DB),origin);
      if(path==='/api/v2/history'&&req.method==='GET')return reply(200,{versions:await listDocumentHistory(env.DB)},origin);
      if(/^\/api\/v2\/history\/\d+$/.test(path)&&req.method==='GET'){
        const saved=await readDocumentVersion(env.DB,Number(path.split('/').pop()));
        return saved?reply(200,saved,origin):text(404,'Saved version no longer available',origin);
      }
      if(path==='/api/v2/state'&&req.method==='PUT'){
        const body=await readJson(req);
        if(!Number.isSafeInteger(body.version)||body.version<0||!GagebuValidation.validV2(body.data))return text(400,'Invalid V2 state payload',origin);
        const result=await writeDocument(env.DB,body.version,body.data);
        return reply(result.conflict?409:200,result,origin);
      }
      return text(404,'Not found',origin);
    }catch(error){
      console.error('Ledger API error',error?.message);
      if(error instanceof SyntaxError||/JSON Content-Type required|Request exceeds/.test(error?.message||''))return text(400,'Invalid request body',origin);
      return text(500,'Server request failed',origin);
    }
  }
};
