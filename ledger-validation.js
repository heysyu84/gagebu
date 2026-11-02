/* Shared data checks. No financial data is embedded in application code. */
(function(root){
'use strict';
const MAX_AMOUNT=999999999999;
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const date=x=>typeof x==='string'&&/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(x)&&!Number.isNaN(Date.parse(x+'T00:00:00Z'))&&new Date(x+'T00:00:00Z').toISOString().slice(0,10)===x;
const amount=x=>Number.isSafeInteger(x)&&x>=0&&x<=MAX_AMOUNT;
const id=x=>typeof x==='string'&&x.length>0&&x.length<=180;
const unique=(rows,key)=>new Set(rows.map(x=>x[key])).size===rows.length;
const boundedStrings=x=>Object.values(x).every(v=>typeof v!=='string'||v.length<=20000);
const strings=x=>Array.isArray(x)&&x.every(v=>typeof v==='string'&&v.length<=20000);
const labels=x=>object(x)&&Object.values(x).every(v=>typeof v==='string'&&v.length<=500);
const classificationKeys=['scope','ledgerType','category','subcategory','status','manual','confidence','reason','ruleId','detailSubcategory','scopeBeforeExclusion'];
const classificationSnapshot=x=>object(x)&&Object.entries(x).every(([key,value])=>classificationKeys.includes(key)&&(value===null||['string','number','boolean'].includes(typeof value))&&(typeof value!=='string'||value.length<=20000));
const validChange=x=>object(x)&&typeof x.id==='string'&&x.id.length>0&&x.id.length<=420&&id(x.recordId)&&date(x.date)&&amount(x.amount)&&typeof x.merchant==='string'&&x.merchant.length<=20000&&typeof x.at==='string'&&x.at.length<=40&&Number.isFinite(Date.parse(x.at))&&typeof x.source==='string'&&x.source.length<=200&&Array.isArray(x.fields)&&x.fields.length>0&&x.fields.length<=classificationKeys.length&&new Set(x.fields).size===x.fields.length&&x.fields.every(key=>classificationKeys.includes(key))&&classificationSnapshot(x.before)&&classificationSnapshot(x.after)&&(x.undoneAt===undefined||(typeof x.undoneAt==='string'&&x.undoneAt.length<=40&&Number.isFinite(Date.parse(x.undoneAt))));
function validV2(x){
 if(!object(x)||x.version!==2||!Array.isArray(x.records)||x.records.length>20000)return false;
 if(!x.records.every(r=>object(r)&&id(r.id)&&date(r.date)&&amount(r.amount)&&['income','expense','transfer'].includes(r.direction)&&['confirmed','review','excluded'].includes(r.status)&&boundedStrings(r))||!unique(x.records,'id'))return false;
 if(!Array.isArray(x.dailyLotto)||x.dailyLotto.length>10000||!x.dailyLotto.every(r=>object(r)&&id(r.id)&&date(r.date)&&amount(r.handle)&&amount(r.commission))||!unique(x.dailyLotto,'date'))return false;
 if(!object(x.storeProfits)||!Object.entries(x.storeProfits).every(([k,v])=>/^\d{4}-(?:0[1-9]|1[0-2])$/.test(k)&&Number.isSafeInteger(v)&&Math.abs(v)<=MAX_AMOUNT))return false;
 if(!Array.isArray(x.refunds)||x.refunds.length>20000||!unique(x.refunds,'id')||!x.refunds.every(r=>object(r)&&id(r.id)&&date(r.date)&&amount(r.amount)&&r.amount>0&&['matched','review','excluded'].includes(r.status)&&boundedStrings(r)))return false;
 const purchases=new Set(x.records.filter(r=>r.direction==='expense').map(r=>r.id));
 if(x.refunds.some(r=>r.status==='matched'&&!purchases.has(r.refundOf)))return false;
 if(x.taxonomy!==undefined&&x.taxonomy!==null&&(!object(x.taxonomy)||!Object.values(x.taxonomy).every(group=>object(group)&&Object.values(group).every(strings))))return false;
 if(['paymentMethods','hiddenPaymentMethods'].some(k=>x[k]!==undefined&&!strings(x[k])))return false;
 if(x.paymentAliases!==undefined&&!labels(x.paymentAliases))return false;
 if(x.customLabels!==undefined&&(!object(x.customLabels)||['scopes','groups'].some(k=>x.customLabels[k]!==undefined&&!labels(x.customLabels[k]))))return false;
 if(x.records.some(r=>['merchant','time','scope','ledgerType','category','subcategory','payment','note','bankPayment','source','sourceSheet'].some(k=>r[k]!==undefined&&typeof r[k]!=='string')))return false;
 if(x.classificationHistory!==undefined&&(!Array.isArray(x.classificationHistory)||x.classificationHistory.length>100||!x.classificationHistory.every(validChange)))return false;
 return ['customRules','rentRecipients','customLabels'].every(k=>x[k]===undefined||object(x[k]))&&['imports','excludedAudit','paymentMethods','hiddenPaymentMethods','taxonomyAliases'].every(k=>x[k]===undefined||Array.isArray(x[k]))&&(x.lottoRatePct===undefined||(typeof x.lottoRatePct==='number'&&x.lottoRatePct>=0&&x.lottoRatePct<=100));
}
const empty=x=>!(x.records||[]).length&&!(x.dailyLotto||[]).length&&!(x.refunds||[]).length&&!Object.keys(x.storeProfits||{}).length;
const koreaDate=(value=new Date())=>new Date(new Date(value).getTime()+9*3600000).toISOString().slice(0,10);
root.GagebuValidation={date,amount,validV2,empty,koreaDate};
})(globalThis);
