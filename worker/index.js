/**
 * STORE LEDGER private API (Cloudflare Worker + D1).
 * No personal ledger data or passwords belong in GitHub or published website files.
 * ADMIN_PASSWORD and SESSION_PEPPER must be set with `wrangler secret put`.
 */
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
const validRecord=x=>x&&typeof x==='object'&&typeof x.id==='string'&&x.id.length<180&&/^\d{4}-\d{2}-\d{2}$/.test(x.date)&&Number.isSafeInteger(x.amount)&&x.amount>=0&&x.amount<=999999999999&&['income','expense','transfer'].includes(x.kind)&&String(x.category||'').length<=220&&String(x.note||'').length<=2500;
const validDaily=x=>x&&typeof x.id==='string'&&x.id.length<180&&/^\d{4}-\d{2}-\d{2}$/.test(x.date)&&Number.isSafeInteger(x.commission)&&x.commission>=0&&x.commission<=999999999999&&(x.handle==null||(Number.isSafeInteger(x.handle)&&x.handle>=0&&x.handle<=999999999999));
const validState=x=>x&&x.schema==='store-ledger-v1'&&Array.isArray(x.transactions)&&x.transactions.length<=20000&&x.transactions.every(validRecord)&&new Set(x.transactions.map(y=>y.id)).size===x.transactions.length&&Array.isArray(x.dailyLotto)&&x.dailyLotto.length<=6000&&x.dailyLotto.every(validDaily)&&new Set(x.dailyLotto.map(y=>y.date)).size===x.dailyLotto.length;
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
    if(path==='/health'&&req.method==='GET')return reply(200,{ok:true,service:'store-ledger-api'},origin);
    if(!env.DB||!env.ADMIN_PASSWORD||!env.SESSION_PEPPER)return text(503,'Server setup incomplete',origin);
    try{
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
        await env.DB.prepare('INSERT INTO ledger_sessions(token_hash,created_at,expires_at) VALUES(?,?,?)').bind(await digest(`${env.SESSION_PEPPER}:${token}`),now(),now()+SESSION_SECONDS).run();
        return reply(200,{token,expiresAt:now()+SESSION_SECONDS},origin);
      }
      if(!path.startsWith('/api/'))return text(404,'Not found',origin);
      if(!await verify(req,env))return text(401,'Login required',origin);
      if(path==='/api/logout'&&req.method==='POST'){
        const token=getToken(req);await env.DB.prepare('DELETE FROM ledger_sessions WHERE token_hash = ?').bind(await digest(`${env.SESSION_PEPPER}:${token}`)).run();
        return reply(200,{ok:true},origin);
      }
      if(path==='/api/state'&&req.method==='GET'){
        const row=await env.DB.prepare(`SELECT version,content,updated_at FROM ledger_data WHERE ledger_key = 'main'`).first();
        if(!row)return text(503,'D1 schema missing',origin);
        return reply(200,{version:row.version,updatedAt:row.updated_at,data:JSON.parse(row.content)},origin);
      }
      if(path==='/api/state'&&req.method==='PUT'){
        const body=await readJson(req);
        if(!Number.isSafeInteger(body.version)||body.version<0||!validState(body.data))return text(400,'Invalid state payload',origin);
        const serialized=JSON.stringify(body.data);
        if(enc.encode(serialized).length>MAX_BODY_BYTES)return text(413,'Ledger too large',origin);
        const old=await env.DB.prepare(`SELECT version,content FROM ledger_data WHERE ledger_key = 'main'`).first();
        if(!old)return text(503,'D1 schema missing',origin);
        if(old.version!==body.version)return reply(409,{error:'Version conflict',serverVersion:old.version},origin);
        const result=await env.DB.prepare(`UPDATE ledger_data SET version=version+1,content=?,updated_at=datetime('now') WHERE ledger_key='main' AND version=?`).bind(serialized,body.version).run();
        if((result.meta?.changes||0)!==1)return reply(409,{error:'Concurrent update',serverVersion:old.version},origin);
        try{
          await env.DB.prepare('INSERT INTO ledger_history(previous_version,content) VALUES(?,?)').bind(old.version,old.content).run();
          await env.DB.prepare('DELETE FROM ledger_history WHERE id NOT IN (SELECT id FROM ledger_history ORDER BY id DESC LIMIT 30)').run();
        }catch(err){console.error('Nonblocking backup error',err)}
        return reply(200,{ok:true,version:body.version+1},origin);
      }
      return text(404,'Not found',origin);
    }catch(error){
      console.error('Ledger API error',error?.message);
      if(error instanceof SyntaxError||/JSON Content-Type required|Request exceeds/.test(error?.message||''))return text(400,'Invalid request body',origin);
      return text(500,'Server request failed',origin);
    }
  }
};