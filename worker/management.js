import {readDocument,writeDocument} from './storage.js';
const own=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
const same=(a,b,k)=>own(a,k)===own(b,k)&&JSON.stringify(a[k])===JSON.stringify(b[k]);
const classification=['scope','ledgerType','category','subcategory','status'];
const transactionFields=['date','amount','merchant','payment','note','scope','ledgerType','category','subcategory'];
const metadataFields=['manual','reason','confidence','ruleId','detailSubcategory','scopeBeforeExclusion'];
const refundFields=['status','refundOf','manual','reason'];
const identity=row=>({date:row.date,merchant:row.merchant||'',amount:row.amount});
const brief=row=>Object.fromEntries(['id','date','time','merchant','amount','direction','scope','ledgerType','category','subcategory','status','payment','refundOf'].filter(k=>own(row,k)).map(k=>[k,row[k]]));
const fail=(message,status=400)=>{const e=Error(message);e.status=status;throw e};
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const checkKeys=(x,keys)=>{if(!object(x)||Object.keys(x).some(k=>!keys.includes(k)))fail('허용되지 않은 입력입니다.');};
const checkIdentity=(row,expected)=>{
 checkKeys(expected,['date','merchant','amount']);
 if(!['date','merchant','amount'].every(k=>own(expected,k)&&same(identity(row),expected,k)))fail('거래의 날짜·거래처·금액이 예상과 다릅니다. 다시 조회하세요.',409);
};
const withVersion=(data,expected)=>{if(!Number.isSafeInteger(expected)||expected!==data.version)fail('장부 버전이 바뀌었습니다. 다시 조회한 뒤 수정하세요.',409);};
const patch=(row,values,keys)=>{for(const k of keys){if(own(values,k))row[k]=values[k];else delete row[k]}};
function audit(actor,kind,row,before,reason,undoOf){
 const keys=[...new Set([...Object.keys(before),...Object.keys(row)])].filter(k=>!same(before,row,k));
 const a={},b={};for(const k of keys){if(own(before,k))a[k]=before[k];if(own(row,k))b[k]=row[k]}
 return {id:crypto.randomUUID(),actor,kind,targetId:row.id,before:a,after:b,identity:identity(row),reason,at:new Date().toISOString(),undoOf};
}
function addClassificationHistory(state,a){
 if(a.kind!=='transaction'||!Object.keys(a.before).concat(Object.keys(a.after)).some(k=>classification.includes(k)))return;
 const fields=[...new Set([...Object.keys(a.before),...Object.keys(a.after)])].filter(k=>classification.concat(metadataFields).includes(k));
 const pick=x=>Object.fromEntries(fields.filter(k=>own(x,k)).map(k=>[k,x[k]]));
 state.classificationHistory=[{id:a.id,recordId:a.targetId,...a.identity,at:a.at,source:'관리 도구',fields,before:pick(a.before),after:pick(a.after)},...(state.classificationHistory||[])].slice(0,100);
}
export async function callManagement(name,input,env,principal){
 if(!principal?.scopes?.includes('gagebu:read'))fail('가계부 조회 권한이 없습니다.',403);
 if(name==='sites_status'){
  checkKeys(input,[]);
  const row=await env.DB.prepare("SELECT version FROM ledger_documents WHERE ledger_key='main-v2'").first();
  return {sites:[{id:'gagebu',name:'가계부',connected:true,version:row?.version??0},{id:'windmoon',name:'풍월관',connected:false},{id:'clan',name:'클전',connected:false}],writable:principal.scopes.includes('gagebu:write')};
 }
 if(name==='ledger_changes'){
  checkKeys(input,['targetId','limit']);const limit=input.limit??10;
  if(!Number.isSafeInteger(limit)||limit<1||limit>20)fail('조회 건수는 1~20건입니다.');
  if(input.targetId!==undefined&&(typeof input.targetId!=='string'||input.targetId.length>180))fail('거래 ID를 확인하세요.');
  const doc=await readDocument(env.DB),query='SELECT * FROM management_changes'+(input.targetId?' WHERE target_id=?':'')+' ORDER BY created_at DESC LIMIT ?';
  const rows=await env.DB.prepare(query).bind(...(input.targetId?[input.targetId,limit]:[limit])).all();
  const changes=rows.results.map(r=>({id:r.id,kind:r.kind,targetId:r.target_id,identity:JSON.parse(r.identity_json),before:JSON.parse(r.before_json),after:JSON.parse(r.after_json),reason:r.reason,at:r.created_at,version:r.version_after,undoOf:r.undo_of}));
  const ids=new Set(changes.map(x=>x.id));
  const older=(doc.data?.classificationHistory||[]).filter(x=>!ids.has(x.id)&&(!input.targetId||x.recordId===input.targetId)).slice(0,limit).map(x=>({id:x.id,kind:'transaction',targetId:x.recordId,identity:{date:x.date,merchant:x.merchant,amount:x.amount},before:x.before,after:x.after,reason:x.source,at:x.at,undoneAt:x.undoneAt}));
  const combined=[...changes,...older].sort((a,b)=>b.at.localeCompare(a.at)).slice(0,limit);
  for(const change of combined){const row=(change.kind==='refund'?doc.data?.refunds:doc.data?.records)?.find(r=>r.id===change.targetId);change.canUndo=!!row&&!change.undoneAt&&[...new Set([...Object.keys(change.before),...Object.keys(change.after)])].every(k=>same(row,change.after,k));}
  return {version:doc.version,changes:combined};
 }
 const doc=await readDocument(env.DB);if(!doc.data)fail('서버에 장부가 없습니다.',404);
 if(name==='ledger_find'){
  checkKeys(input,['kind','id','from','to','merchant','amount','status','scope','limit','offset']);
  const kind=input.kind??'transaction',limit=input.limit??10,offset=input.offset??0;
  if(!['transaction','refund'].includes(kind)||!Number.isSafeInteger(limit)||limit<1||limit>20||!Number.isSafeInteger(offset)||offset<0||offset>20000)fail('검색 범위를 확인하세요.');
  for(const key of ['from','to'])if(input[key]!==undefined&&!GagebuValidation.date(input[key]))fail('검색 날짜를 확인하세요.');
  for(const key of ['id','merchant','status','scope'])if(input[key]!==undefined&&(typeof input[key]!=='string'||input[key].length>180))fail('검색어를 확인하세요.');
  if(input.amount!==undefined&&!GagebuValidation.amount(input.amount))fail('금액을 확인하세요.');
  let rows=(kind==='refund'?doc.data.refunds:doc.data.records).filter(r=>(!input.id||r.id===input.id)&&(!input.from||r.date>=input.from)&&(!input.to||r.date<=input.to)&&(!input.merchant||String(r.merchant||'').toLowerCase().includes(input.merchant.toLowerCase()))&&(input.amount===undefined||r.amount===input.amount)&&(!input.status||r.status===input.status)&&(!input.scope||r.scope===input.scope));
  rows=rows.slice().sort((a,b)=>b.date.localeCompare(a.date)||String(a.id).localeCompare(String(b.id)));
  return {version:doc.version,total:rows.length,offset,items:rows.slice(offset,offset+limit).map(brief),nextOffset:offset+limit<rows.length?offset+limit:null};
 }
 if(!principal.scopes.includes('gagebu:write'))fail('가계부 수정 권한이 필요합니다.',403);
 withVersion(doc,input.expectedVersion);
 const state=structuredClone(doc.data),audits=[];
 if(name==='ledger_update_transaction'){
  checkKeys(input,['expectedVersion','updates','reason']);
  if(!Array.isArray(input.updates)||input.updates.length<1||input.updates.length>20||new Set(input.updates.map(x=>x?.id)).size!==input.updates.length)fail('서로 다른 거래 1~20건을 지정하세요.');
  if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>500)fail('수정 사유를 1~500자로 입력하세요.');
  for(const item of input.updates){
   checkKeys(item,['id','expected','changes']);checkKeys(item.changes,transactionFields);
   const row=state.records.find(x=>x.id===item.id&&x.direction==='expense');if(!row)fail('지출 거래를 찾을 수 없습니다.',404);
   checkIdentity(row,item.expected);if(!Object.keys(item.changes).length)fail('변경할 값을 지정하세요.');
   if(own(item.changes,'date')&&!GagebuValidation.date(item.changes.date))fail('거래 날짜를 확인하세요.');
   if(own(item.changes,'amount')&&(!GagebuValidation.amount(item.changes.amount)||item.changes.amount<1))fail('금액은 1원 이상의 정수여야 합니다.');
   for(const key of ['merchant','payment','note','category','subcategory'])if(own(item.changes,key)&&(typeof item.changes[key]!=='string'||item.changes[key].length>(key==='note'?2000:500)||(key==='merchant'&&!item.changes[key].trim())))fail('거래 문자열을 확인하세요.');
   if(own(item.changes,'scope')&&!['personal','business','windmoon','review','excluded'].includes(item.changes.scope))fail('사용처를 확인하세요.');
   if(own(item.changes,'ledgerType')&&!['fixed','consumption'].includes(item.changes.ledgerType))fail('지출 종류를 확인하세요.');
   const before=structuredClone(row);Object.assign(row,item.changes);
   if(own(item.changes,'scope'))row.status=row.scope==='review'?'review':row.scope==='excluded'?'excluded':'confirmed';
   if(['scope','ledgerType','category','subcategory'].some(k=>own(item.changes,k))){
    if(!['fixed','consumption'].includes(row.ledgerType))row.ledgerType='consumption';
    row.category=String(row.category||'기타').trim()||'기타';
    for(const alias of state.taxonomyAliases||[]){if(alias.group!==row.ledgerType)continue;if(alias.type==='major'&&alias.from===row.category)row.category=alias.to;if(alias.type==='minor'&&alias.major===row.category&&alias.from===row.subcategory)row.subcategory=alias.to;}
   }
   if(row.scope==='windmoon'&&row.subcategory!=='풍월관'){if(row.subcategory)row.detailSubcategory=row.subcategory;row.subcategory='풍월관';}
   if(state.taxonomy&&['fixed','consumption'].includes(row.ledgerType)){
    const group=state.taxonomy[row.ledgerType]||=Object.create(null);
    if(!Object.hasOwn(group,row.category))Object.defineProperty(group,row.category,{value:[],enumerable:true,writable:true,configurable:true});
    if(row.subcategory&&!group[row.category].includes(row.subcategory))group[row.category].push(row.subcategory);
   }
   if(transactionFields.every(k=>same(before,row,k))&&before.status===row.status)continue;
   row.manual=true;row.reason=input.reason;
   const a=audit(principal.actor,'transaction',row,before,input.reason);audits.push(a);addClassificationHistory(state,a);
  }
 }else if(name==='ledger_manage_refund'){
  checkKeys(input,['expectedVersion','id','expected','action','purchaseId','allowExcess','reason']);
  if(!['link','unlink','exclude','restore'].includes(input.action))fail('환불 작업을 확인하세요.');
  if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>500)fail('수정 사유를 입력하세요.');
  const row=state.refunds.find(x=>x.id===input.id);if(!row)fail('환불을 찾을 수 없습니다.',404);checkIdentity(row,input.expected);
  const before=structuredClone(row);
  if(input.action==='link'){
   const purchase=state.records.find(x=>x.id===input.purchaseId&&x.direction==='expense'&&x.status!=='excluded');if(!purchase)fail('원결제를 찾을 수 없습니다.',404);
   const total=state.refunds.filter(x=>x.id!==row.id&&x.status==='matched'&&x.refundOf===purchase.id).reduce((v,x)=>v+x.amount,0)+row.amount;
   if(total>purchase.amount&&input.allowExcess!==true)fail('환불 합계가 원결제보다 큽니다. 사용자 확인 후 allowExcess를 지정하세요.',409);
   row.status='matched';row.refundOf=purchase.id;
  }else{row.status=input.action==='exclude'?'excluded':'review';row.refundOf=null;}
  if(refundFields.every(k=>same(before,row,k)))return {version:doc.version,changed:false};
  row.manual=true;row.reason=input.reason;audits.push(audit(principal.actor,'refund',row,before,input.reason));
 }else if(name==='ledger_undo'){
  checkKeys(input,['expectedVersion','changeId','reason']);
  if(typeof input.changeId!=='string'||input.changeId.length>420||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>500)fail('되돌릴 변경과 사유를 확인하세요.');
  const saved=await env.DB.prepare('SELECT * FROM management_changes WHERE id=?').bind(input.changeId).first();
  const legacy=state.classificationHistory?.find(x=>x.id===input.changeId);
  const change=saved?{kind:saved.kind,targetId:saved.target_id,before:JSON.parse(saved.before_json),after:JSON.parse(saved.after_json)}:legacy&&!legacy.undoneAt?{kind:'transaction',targetId:legacy.recordId,before:legacy.before,after:legacy.after}:null;
  if(!change)fail('되돌릴 변경을 찾을 수 없습니다.',404);
  const row=(change.kind==='refund'?state.refunds:state.records).find(x=>x.id===change.targetId);if(!row)fail('거래를 찾을 수 없습니다.',404);
  const fields=[...new Set([...Object.keys(change.before),...Object.keys(change.after)])],allow=change.kind==='refund'?refundFields:transactionFields.concat('status',...metadataFields);
  if(!fields.length||fields.some(k=>!allow.includes(k)))fail('이 변경은 되돌릴 수 없습니다.');
  if(!fields.every(k=>same(row,change.after,k)))fail('해당 거래가 이후에 다시 변경됐습니다. 최신 값을 확인하세요.',409);
  const before=structuredClone(row);patch(row,change.before,fields);
  const a=audit(principal.actor,change.kind,row,before,input.reason,input.changeId);audits.push(a);
  if(legacy)legacy.undoneAt=a.at;addClassificationHistory(state,a);
 }else fail('지원하지 않는 관리 기능입니다.',404);
 if(!audits.length)return {version:doc.version,changed:false};
 if(!GagebuValidation.validV2(state))fail('변경 후 장부 검증에 실패했습니다. 저장하지 않았습니다.');
 const result=await writeDocument(env.DB,doc.version,state,{audits});if(result.conflict)fail('다른 변경이 먼저 저장됐습니다. 다시 조회하세요.',409);
 const verified=await readDocument(env.DB);
 const receipts=audits.map(a=>{const row=(a.kind==='refund'?verified.data.refunds:verified.data.records).find(x=>x.id===a.targetId);return {changeId:a.id,kind:a.kind,record:brief(row||{}),before:a.before,after:a.after,verified:!!row&&Object.keys(a.after).concat(Object.keys(a.before)).every(k=>same(row,a.after,k))};});
 return {changed:true,version:verified.version,committedVersion:result.version,receipts};
}
