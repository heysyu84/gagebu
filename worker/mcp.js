import {callManagement} from './management.js';
import {verifyMcpToken,oauthJSON} from './mcp-oauth.js';
const id={type:'string',minLength:1,maxLength:180};
const identity={type:'object',properties:{date:{type:'string',format:'date'},merchant:{type:'string'},amount:{type:'integer',minimum:0}},required:['date','merchant','amount'],additionalProperties:false};
const version={type:'integer',minimum:0};
const reason={type:'string',minLength:1,maxLength:500};
const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
export const MCP_TOOLS=[
 {name:'sites_status',title:'사이트 연결 상태',description:'List connected sites and ledger version. Windmoon and clan are not connected yet.',inputSchema:schema({}),read:true},
 {name:'ledger_find',title:'거래·환불 찾기',description:'Find at most 20 transactions or refunds. Returns the current version, exact record IDs and identity fields needed for writes. Do not guess among multiple matches.',inputSchema:schema({kind:{type:'string',enum:['transaction','refund'],default:'transaction'},id,from:{type:'string',format:'date'},to:{type:'string',format:'date'},merchant:{type:'string',maxLength:180},amount:{type:'integer',minimum:0},status:{type:'string',enum:['review','confirmed','matched','excluded']},scope:{type:'string',enum:['personal','business','windmoon','review','excluded']},limit:{type:'integer',minimum:1,maximum:20,default:10},offset:{type:'integer',minimum:0,maximum:20000}}),read:true},
 {name:'ledger_update_transaction',title:'거래 수정',description:'Update 1–20 existing expense records in one atomic save, only after the user identifies them. Requires the version and exact current identity from ledger_find. Personal=개인, business=편의점, windmoon=풍월관, review=미분류, excluded=제외. No deployment is needed. Returns verified receipts and undo IDs.',inputSchema:schema({expectedVersion:version,reason,updates:{type:'array',minItems:1,maxItems:20,items:schema({id,expected:identity,changes:schema({date:{type:'string',format:'date'},amount:{type:'integer',minimum:1,maximum:999999999999},merchant:{type:'string',minLength:1,maxLength:500},payment:{type:'string',maxLength:500},note:{type:'string',maxLength:2000},scope:{type:'string',enum:['personal','business','windmoon','review','excluded']},ledgerType:{type:'string',enum:['fixed','consumption']},category:{type:'string',maxLength:80},subcategory:{type:'string',maxLength:80}})},['id','expected','changes'])}},['expectedVersion','reason','updates']),read:false},
 {name:'ledger_manage_refund',title:'환불 관리',description:'Link, unlink, exclude or restore an existing refund. A refund counts on its own date; linking never changes its amount or date. Requires current identity/version. allowExcess=true is only for user-confirmed over-refunds or exchange-rate differences.',inputSchema:schema({expectedVersion:version,id,expected:identity,action:{type:'string',enum:['link','unlink','exclude','restore']},purchaseId:id,allowExcess:{type:'boolean',default:false},reason},['expectedVersion','id','expected','action','reason']),read:false},
 {name:'ledger_changes',title:'최근 변경 조회',description:'Read at most 20 recent changes, exact before/after values and canUndo. Includes saved UI classification history. Use this to investigate an unknown accidental change; never assume the last change is the mistaken one.',inputSchema:schema({targetId:id,limit:{type:'integer',minimum:1,maximum:20,default:10}}),read:true},
 {name:'ledger_undo',title:'선택한 변경 되돌리기',description:'Undo one user-identified change ID. Preserves unrelated fields and other records. Stops if the affected fields changed again. Obtain expectedVersion from a fresh read.',inputSchema:schema({expectedVersion:version,changeId:{type:'string',minLength:1,maxLength:420},reason},['expectedVersion','changeId','reason']),read:false}
];
const versions=['2026-07-28','2025-11-25','2025-06-18','2025-03-26'];
const rpc=(id,result)=>oauthJSON(200,{jsonrpc:'2.0',id,result});
const rpcError=(id,code,message)=>oauthJSON(200,{jsonrpc:'2.0',id,error:{code,message}});
export async function handleMcp(req,env){
 const origin=new URL(req.url).origin;
 if(req.method!=='POST')return oauthJSON(405,{error:'Use POST for this stateless MCP endpoint.'},{Allow:'POST'});
 const principal=await verifyMcpToken(req,env);
 if(!principal)return oauthJSON(401,{error:'authorization_required'},{'WWW-Authenticate':'Bearer resource_metadata="'+origin+'/.well-known/oauth-protected-resource/mcp", scope="gagebu:read"'});
 if(!String(req.headers.get('content-type')||'').startsWith('application/json'))return oauthJSON(415,{error:'application/json required'});
 let body;try{const raw=await req.text();if(new TextEncoder().encode(raw).length>131072)return oauthJSON(413,{error:'Request too large'});body=JSON.parse(raw)}catch{return rpcError(null,-32700,'Invalid JSON')}
 if(!body||typeof body!=='object'||Array.isArray(body)||body.jsonrpc!=='2.0'||typeof body.method!=='string')return rpcError(null,-32600,'Invalid JSON-RPC request');
 const requestId=body.id??null,metadata=body.params?._meta||body._meta||{},specified=metadata['io.modelcontextprotocol/protocolVersion'],header=req.headers.get('MCP-Protocol-Version');
 if(header&&!versions.includes(header)||specified&&(!versions.includes(specified)||header&&header!==specified))return oauthJSON(400,{error:'Protocol version mismatch'});
 if(body.method.startsWith('notifications/'))return new Response(null,{status:202,headers:{'Cache-Control':'no-store'}});
 if(!Object.hasOwn(body,'id')||!['number','string'].includes(typeof body.id))return rpcError(null,-32600,'A request ID is required');
 const info={name:'personal-sites-manager',version:'1.0.0'};
 if(body.method==='server/discover')return rpc(requestId,{supportedVersions:versions,capabilities:{tools:{}},serverInfo:info});
 if(body.method==='initialize')return rpc(requestId,{protocolVersion:versions.includes(body.params?.protocolVersion)?body.params.protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:info,instructions:'Use narrow searches. Identify the exact transaction before writing. Never guess which change was accidental. Writes need a fresh version and exact current identity; verify receipts. Site operation is independent of this MCP connection.'});
 if(body.method==='ping')return rpc(requestId,{});
 if(body.method==='tools/list')return rpc(requestId,{tools:MCP_TOOLS.filter(t=>t.read||principal.scopes.includes('gagebu:write')).map(({read,...tool})=>({...tool,annotations:{readOnlyHint:read,destructiveHint:!read,idempotentHint:read,openWorldHint:false}}))});
 if(body.method==='tools/call'){
  const tool=MCP_TOOLS.find(t=>t.name===body.params?.name);if(!tool)return rpcError(requestId,-32602,'Unknown tool');
  if(!tool.read&&!principal.scopes.includes('gagebu:write'))return rpc(requestId,{content:[{type:'text',text:'가계부 수정 권한이 없습니다.'}],isError:true});
  try{
   const result=await callManagement(tool.name,body.params.arguments??{},env,principal);
   return rpc(requestId,{content:[{type:'text',text:JSON.stringify(result)}],isError:false});
  }catch(error){return rpc(requestId,{content:[{type:'text',text:JSON.stringify({error:error.status<500?error.message:'서버 작업에 실패했습니다.',status:error.status||500,retryable:error.status===409})}],isError:true})}
 }
 return rpcError(requestId,-32601,'Method not found');
}
