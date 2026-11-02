// Deployment-only protocol check. Never edits financial records or prints tokens.
import {randomBytes,createHash} from 'node:crypto';
const base=process.env.MCP_BASE_URL||'https://store-ledger-private-api.heysyu84.workers.dev';
const password=process.env.LEDGER_ADMIN_PASSWORD;
if(!password)throw Error('Missing private deployment setting');
const resource=base+'/mcp',redirect='https://example.invalid/mcp-deployment-check';
const request=(path,options={})=>fetch(base+path,{...options,redirect:'manual',signal:AbortSignal.timeout(15000)});
const jsonRequest=(path,body,headers={})=>request(path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
const formRequest=(path,form,headers={})=>request(path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams(form)});
const ok=async response=>{if(!response.ok)throw Error('MCP check HTTP '+response.status);return response.json()};
let ready=false;
for(let attempt=0;attempt<6;attempt++){
 const response=await request('/.well-known/oauth-protected-resource/mcp');
 if(response.ok&&(await response.json()).resource===resource){ready=true;break}
 if(attempt<5)await new Promise(resolve=>setTimeout(resolve,2000));
}
if(!ready)throw Error('New MCP endpoint has not reached this region yet; financial records were not touched.');
const sitesOrigin="https://gagebu-money-desk.heysyu457310.chatgpt.site";
const sitesPreflight=await request('/api/login',{method:'OPTIONS',headers:{Origin:sitesOrigin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'}});
if(sitesPreflight.status!==204||sitesPreflight.headers.get('access-control-allow-origin')!==sitesOrigin)throw Error('Sites CORS preflight failed');
const sitesAnonymous=await request('/api/v2/state',{headers:{Origin:sitesOrigin}});
if(sitesAnonymous.status!==401)throw Error('Sites origin bypassed ledger authentication');
const client=await ok(await jsonRequest('/oauth/register',{client_name:'연결 확인용 · 조회 전용',redirect_uris:[redirect],token_endpoint_auth_method:'none'}));
const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
const query=new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',scope:'gagebu:read',resource,code_challenge_method:'S256',code_challenge:challenge,state:randomBytes(16).toString('hex')});
const approval=await request('/oauth/authorize?'+query),html=await approval.text(),flow=html.match(/name="flow" value="([^"]+)"/)?.[1],cookie=approval.headers.get('set-cookie')?.split(';')[0];
if(!flow||!cookie)throw Error('OAuth approval form missing');
if(approval.headers.get('referrer-policy')!=='same-origin')throw Error('OAuth form hides the browser POST Origin');
const formAction=approval.headers.get('content-security-policy')?.split(';').map(x=>x.trim()).find(x=>x.startsWith('form-action '));
if(formAction!=="form-action 'self' "+new URL(redirect).origin)throw Error('OAuth form blocks its registered callback');
const consent=await formRequest('/oauth/authorize',{flow,password,decision:'allow'},{Origin:base,Cookie:cookie});
if(consent.status!==302)throw Error('OAuth sign-in check failed');
const callback=new URL(consent.headers.get('location'));if(callback.searchParams.get('state')!==query.get('state'))throw Error('OAuth state mismatch');
const tokens=await ok(await formRequest('/oauth/token',{grant_type:'authorization_code',client_id:client.client_id,redirect_uri:redirect,resource,code:callback.searchParams.get('code'),code_verifier:verifier}));
const call=async(method,params={})=>ok(await jsonRequest('/mcp',{jsonrpc:'2.0',id:1,method,params},{Authorization:'Bearer '+tokens.access_token}));
try{
 const discovery=await call('server/discover');if(!discovery.result?.supportedVersions.includes('2026-07-28'))throw Error('MCP discovery failed');
 const list=await call('tools/list');if(list.result?.tools.length!==3)throw Error('Read-only tool list mismatch');
 const before=JSON.parse((await call('tools/call',{name:'sites_status',arguments:{}})).result.content[0].text);
 const denied=await call('tools/call',{name:'ledger_update_transaction',arguments:{}});if(!denied.result?.isError)throw Error('Read-only token unexpectedly accepted a write');
 const after=JSON.parse((await call('tools/call',{name:'sites_status',arguments:{}})).result.content[0].text);
 if(before.sites[0].version!==after.sites[0].version)throw Error('Ledger changed during check; no financial write was requested');
 console.log(JSON.stringify({mcpCheck:{oauth:true,browserFormHeaders:true,sitesOrigin:true,discovery:true,readTools:3,writeDenied:true,ledgerVersionUnchanged:true}}));
}finally{
 await ok(await formRequest('/oauth/revoke',{client_id:client.client_id,token:tokens.refresh_token}));
 const revoked=await jsonRequest('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'},{Authorization:'Bearer '+tokens.access_token});
 if(revoked.status!==401)throw Error('Temporary connection revocation failed');
}
