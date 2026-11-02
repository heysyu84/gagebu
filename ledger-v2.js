/* GAGEBU / Money Desk v2 — local-first, bank-import-driven. Never embeds private transaction data. */
(() => {
'use strict';
const KEY='gagebu-v2-private',OLD='gagebu-v1-data';
const $=(q,root=document)=>root.querySelector(q),$$=(q,root=document)=>Array.from(root.querySelectorAll(q));
const E=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
const n=s=>Number(s)||0,won=v=>Math.round(n(v)).toLocaleString('ko-KR')+'원';
const now=()=>GagebuValidation.koreaDate(),ym=()=>now().slice(0,7),uid=()=>crypto.randomUUID();
const G=window.GagebuRules;
const VIEWS={dashboard:'전체 요약',records:'전체 거래내역',sheet:'여러 건 입력',categories:'분류 관리',sales:'매출 관리',lotto:'매출 관리',review:'가져오기 · 분류',import:'가져오기 · 분류',rules:'분류 관리',settings:'저장 · 백업',changes:'최근 변경 · 되돌리기'};
const LABEL={personal:'개인',business:'편의점',windmoon:'풍월관',review:'미분류',excluded:'제외',transfer:'이체'};
const GROUP={fixed:'고정지출',consumption:'소비지출'};
const SOURCE={bank:'뱅크샐러드',legacy:'구글 시트',manual:'직접 입력'};
/* Actual payment funding is distinct from the BankSalad registered card display.
   Onnuri is a prepaid balance: its top-ups are excluded, usage is a single expense. */
const isOnnuri=x=>x.onnuri===true||(!('onnuri' in x)&&/온누리/.test(String(x.payment||'')));
const paymentLabel=x=>isOnnuri(x)?'온누리상품권':String(x.payment||'—');
const registeredCard=x=>isOnnuri(x)?String(x.bankPayment||(/온누리/.test(String(x.payment||''))?'':x.payment)||''):'';
const onnuriLinkedCard=x=>isOnnuri(x)?String(x.onnuriLinkedCard||''):'';
const onnuriCheckbox=(x,location)=>'<label class="onnuri-choice"><input type="checkbox" data-onnuri-id="'+E(x.id)+'" '+(isOnnuri(x)?'checked':'')+' aria-label="'+E(x.merchant||'거래')+' 온누리상품권 사용 여부">'+
  '<span>온누리상품권으로 결제</span></label>';

/* Default Onnuri for repeated use at the EXACT recorded shop. No merchant names hardcoded. */
const onnuriMerchantKey=name=>{
 const k=G.normalizeMerchant(String(name||'').trim());
 return /^(?:거래처미기재|구매처미확인|미분류|기타|알수없음|현금|이체)$/.test(k)?'':k;
};
function onnuriHistoryDefault(merchant,payment=''){
 if(/온누리/.test(String(payment||'')))return {checked:true,auto:false};
 if(/^(?:현금|계좌이체|송금)/.test(String(payment||'').trim()))return {checked:false,auto:false};
 const key=onnuriMerchantKey(merchant);if(!key)return {checked:false,auto:false};
 let yes=0,no=0;
 for(const rec of state.records||[]){
   if(rec.direction!=='expense'||rec.status==='excluded'||rec.onnuriAuto===true)continue;
   if(onnuriMerchantKey(rec.merchant)!==key)continue;
   if(isOnnuri(rec))yes++;else no++;
 }
 const checked=yes>=2&&yes*4>=(yes+no)*3&&(key.length>=4||(yes>=3&&no===0));
 return {checked,auto:checked};
}
function syncEditorOnnuriDefault(){
 if(editing!=='new')return;
 const f=$('#editor-form'),el=f?.elements?.onnuri;
 if(!el||el.dataset.onnuriTouched==='1')return;
 const suggestion=onnuriHistoryDefault(f.elements.merchant.value,f.elements.payment.value);
 el.checked=suggestion.checked;el.dataset.onnuriAuto=suggestion.auto?'1':'0';
 el.title=suggestion.auto?'동일 가게의 과거 온누리 결제 이력으로 자동 체크됨':'';
}
const blank=()=>({version:2,records:[],refunds:[],dailyLotto:[],storeProfits:{},lottoRatePct:5.97,customRules:{},rentRecipients:{},legacyDailySynced:false,bankSaladBaselineVersion:0,fixedPurchasePresetVersion:0,consumptionOnlinePresetVersion:0,taxonomy:null,taxonomyAliases:[],paymentMethods:[],hiddenPaymentMethods:[],paymentAliases:{},customLabels:{scopes:{},groups:{}},imports:[],excludedAudit:[],createdAt:new Date().toISOString()});
let state=blank(),page='dashboard',period='all',scopeFilter='all',typeFilter='all',paymentFilter='all',q='',offset=0,reviewOffset=0,preview=null,editing=null,toastTimer=null,shownTip=false,salesMonth=ym(),lottoMonth=ym(),bankImportRange={from:'2026-01-01',to:now()},lastBankFile=null,bankLoadToken=0;
let sync=null,persistedState=null,storageFailure='',corruptStorage=false,serverBusy=false;
let recordsMode='active',activeRefund='',queryTimer=null;
let serverHistory=[],serverHistoryEntries=[],historyCursor=0,historyOlder=null,historyBusy=false,historyMessage='';
let mcpConnections=null,mcpConnectionBusy=false,mcpConnectionMessage='';
const CLASS_FIELDS=['scope','ledgerType','category','subcategory','status'];
const CLASS_META=['manual','confidence','reason','ruleId','detailSubcategory','scopeBeforeExclusion'];
const owns=(row,key)=>Object.prototype.hasOwnProperty.call(row,key);
const sameField=(a,b,key)=>owns(a,key)===owns(b,key)&&a[key]===b[key];
function classificationChanges(before,after,{at=new Date().toISOString(),prefix='change',source='local'}={}){
 const old=new Map((before.records||[]).map(row=>[row.id,row])),changes=[];
 for(const row of after.records||[]){
  const previous=old.get(row.id);
  if(!previous||!CLASS_FIELDS.some(key=>!sameField(previous,row,key)))continue;
  const scalar=value=>value===null||value===undefined||['string','number','boolean'].includes(typeof value);
  const fields=[...CLASS_FIELDS,...CLASS_META].filter(key=>scalar(previous[key])&&scalar(row[key])&&!sameField(previous,row,key)),a={},b={};
  for(const key of fields){if(owns(previous,key))a[key]=previous[key];if(owns(row,key))b[key]=row[key]}
  changes.push({id:prefix+':'+row.id,recordId:row.id,date:row.date,merchant:row.merchant||'',amount:row.amount,at,source,fields,before:a,after:b});
 }
 return changes;
}
function canUndoClassification(entry){
 const row=state.records.find(x=>x.id===entry.recordId);
 return !!row&&!entry.undoneAt&&entry.fields.every(key=>sameField(row,entry.after,key));
}
function undoClassification(entry,ask=true){
 if(!canUndoClassification(entry)){toast('이 거래는 이후에 다시 변경됐습니다. 최신 변경부터 확인하세요.');return false}
 if(ask&&!confirm(entry.date+' · '+entry.merchant+' · '+won(entry.amount)+'\n이 거래의 분류를 변경 전으로 되돌릴까요?'))return false;
 const row=state.records.find(x=>x.id===entry.recordId);
 for(const key of entry.fields){if(owns(entry.before,key))row[key]=entry.before[key];else delete row[key]}
 const saved=(state.classificationHistory||[]).find(x=>x.id===entry.id);if(saved)saved.undoneAt=new Date().toISOString();
 if(!save()){render();return false}
 if(!saved)entry.undoneAt=new Date().toISOString();
 render();toast('해당 거래의 분류를 변경 전으로 되돌렸습니다.');return true;
}
const dateDiff=(a,b)=>Math.abs((Date.parse(a+'T00:00:00Z')-Date.parse(b+'T00:00:00Z'))/86400000);
const money=val=>Math.abs(Number(val)||0);
const escAttr=E;
/* Migrate the old "풍월관 / 편의점·식비·소모품" layout without dropping the original detail. */
const WINDMOON_OLD_MAJOR={'편의점':'생활','식비':'식비','소모품':'생활','온라인 구매':'온라인쇼핑','운영 관련':'생활'};
function normalizeWindmoon(row){
 if(!row||row.direction!=='expense'||row.scope!=='windmoon')return false;
 let changed=false;
 if(row.category==='풍월관'){
   const oldSub=String(row.subcategory||'');
   row.category=WINDMOON_OLD_MAJOR[oldSub]||'기타';changed=true;
   if(oldSub&&!row.detailSubcategory&&oldSub!==row.category)row.detailSubcategory=oldSub;
 }
 if(!row.category){row.category='기타';changed=true}
 if(row.subcategory!=='풍월관'){
   if(row.subcategory&&!row.detailSubcategory)row.detailSubcategory=row.subcategory;
   row.subcategory='풍월관';changed=true;
 }
 return changed;
}
const ledgerScope=x=>{
 if(/풍월관/.test(String(x.note||'')+' '+String(x.category||'')))return 'windmoon';
 if(x.area==='business')return 'business';
 if(x.area==='review')return 'review';
 if(x.area==='transfer')return 'transfer';
 return 'personal';
};
function migrateLegacy(data){
 if(!data||!Array.isArray(data.transactions))throw Error('가계부 원본 형식이 아닙니다.');
 const entries=data.transactions.map(x=>({
  id:'old-'+String(x.id),date:String(x.date||''),time:'',amount:money(x.amount),
  direction:x.kind==='income'?'income':x.kind==='transfer'?'transfer':'expense',
  scope:ledgerScope(x),ledgerType:x.sourceSheet==='고정지출'?'fixed':x.sourceSheet==='소비지출'?'consumption':'',
  category:String(x.category||''),subcategory:String(x.subcategory||''),
  merchant:String(x.merchant||''),payment:String(x.payment||''),onnuri:/온누리/.test(String(x.payment||'')),note:String(x.note||''),
  source:'legacy',sourceSheet:String(x.sourceSheet||'직접 입력'),sourceId:String(x.id),sourceRow:x.sourceRow??null,
  originalArea:String(x.area||''),status:ledgerScope(x)==='review'?'review':'confirmed',manual:false,bankKey:''
 }));
 return entries.filter(x=>GagebuValidation.date(x.date)&&x.date>='2026-01-01').map(x=>{normalizeWindmoon(x);Object.assign(x,canonicalCategory(x.ledgerType,x.category,x.subcategory));return x});
}

const numInput=raw=>{
 const s=String(raw??'').replace(/[,\s₩원]/g,'');
 return /^\d+$/.test(s)?Number(s):NaN;
};
const signedInput=raw=>{const s=String(raw??'').replace(/[,\s₩원]/g,'');return /^-?\d+$/.test(s)?Number(s):NaN;};
const normalizeDailyLotto=x=>{
 const date=String(x?.date||'');
 if(!GagebuValidation.date(date))return null;
 const commission=Number(x.commission),handle=Number(x.handle);
 if(!Number.isSafeInteger(commission)||commission<0||!Number.isSafeInteger(handle)||handle<0)return null;
 return {id:String(x.id||'lotto-'+date),date,commission,handle,
   sourceSheet:String(x.sourceSheet||'일별 입력'),sourceRow:x.sourceRow??null,
   commissionEstimated:!!x.commissionEstimated};
};
function mergeDailyLotto(rows){
 if(!Array.isArray(rows))return {added:0,skipped:0};
 state.dailyLotto=state.dailyLotto||[];
 const exists=new Set(state.dailyLotto.map(x=>x.date));
 let added=0,skipped=0;
 for(const raw of rows){
   const x=normalizeDailyLotto(raw);
   if(!x||exists.has(x.date)){skipped++;continue}
   state.dailyLotto.push(x);exists.add(x.date);added++;
 }
 return {added,skipped};
}
function mergeStoreProfits(profits){
 const data=profits&&typeof profits==='object'&&!Array.isArray(profits)?profits:{};
 state.storeProfits=state.storeProfits||{};let changed=0;
 for(const [month,raw] of Object.entries(data)){
   const amount=Number(raw);
   if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)||!Number.isSafeInteger(amount))continue;
   if(state.storeProfits[month]===undefined||state.storeProfits[month]===null){
     state.storeProfits[month]=amount;changed++;
   }
 }
 return changed;
}
function save(){
 if(!GagebuValidation.validV2(state)){
  if(persistedState)state=JSON.parse(persistedState);
  toast('변경 내용의 날짜·금액·백업 형식이 올바르지 않아 저장하지 않았습니다. 기존 장부는 유지됩니다.');
  return false;
 }
 try{
  if(corruptStorage)throw Error('저장 자료를 읽지 못했습니다. 데이터 · 설정에서 원본을 백업하세요.');
  if(persistedState){
   const changes=classificationChanges(JSON.parse(persistedState),state,{prefix:uid()});
   if(changes.length)state.classificationHistory=[...changes.reverse(),...(state.classificationHistory||[])].slice(0,100);
  }
  const raw=JSON.stringify(state);localStorage.setItem(KEY,raw);persistedState=raw;storageFailure='';
  if(sync)sync.localChanged();else setStatus('이 브라우저에 저장됨');return true;
 }catch(err){
  if(persistedState)state=JSON.parse(persistedState);
  storageFailure=corruptStorage?'저장 자료 오류 · 원본 보존 중':'저장 실패 · 공간·권한 확인';
  setStatus(storageFailure,'error');toast(corruptStorage?err.message:'저장하지 못했습니다. 저장 공간·브라우저 권한을 확인하고 JSON 백업을 보관하세요.');return false;
 }
}
function load(){
 let hadV2=false;
 try{
   const existing=JSON.parse(localStorage.getItem(KEY)||'null');
   if(existing!==null&&(!existing||existing.version!==2||!Array.isArray(existing.records)))throw Error('Invalid saved ledger');
   if(existing&&existing.version===2&&Array.isArray(existing.records)){
     state={...blank(),...existing};
     if(!Array.isArray(state.dailyLotto))state.dailyLotto=[];
     if(!Array.isArray(state.refunds))state.refunds=[];
     if(!state.storeProfits||typeof state.storeProfits!=='object')state.storeProfits={};
     if(!GagebuValidation.validV2(state))throw Error('Invalid saved ledger');
     persistedState=JSON.stringify(state);
     taxonomy();
     if(!Object.prototype.hasOwnProperty.call(existing,'bankSaladBaselineVersion'))state.bankSaladBaselineVersion=0;
     const bankMigrated=adoptBankSaladDefaults();
     if(bankMigrated)save();
     if(!state.windmoonSubcategoryMigration){
       const migrated=state.records.reduce((n,x)=>n+(normalizeWindmoon(x)?1:0),0);
       state.windmoonSubcategoryMigration=true;
       save();
     }
     hadV2=true;
   }
 }catch(err){corruptStorage=true;storageFailure='저장 자료 오류 · 원본 보존 중';console.warn('V2 load failed');return}
 try{
   const legacy=JSON.parse(localStorage.getItem(OLD)||'null');
   if(legacy&&Array.isArray(legacy.transactions)){
     if(!hadV2){state.records=migrateLegacy(legacy);state.migratedFromV1=true;}
     if(!hadV2||!state.legacyDailySynced){
       mergeDailyLotto(legacy.dailyLotto);
       state.legacyDailySynced=true;
       save();
     }
   }
 }catch(err){console.warn('Legacy load failed',err)}
 // Also initialise a fresh browser before the user hides or renames categories,
 // otherwise the next reload could mistakenly restore a deliberately hidden item.
 if(state.bankSaladBaselineVersion!==2){adoptBankSaladDefaults();save()}
 if(state.fixedPurchasePresetVersion!==1){trimUnusedPurchasePresets();save()}
 if(state.consumptionOnlinePresetVersion!==1){trimUnusedConsumptionOnlinePresets();save()}
 // Cleanup mis-imported month numbers from the saved payment presets only.
 // Historical income/payment source records are preserved verbatim.
 if(Array.isArray(state.paymentMethods)&&state.paymentMethods.some(isPaymentMonthMarker)){
   state.paymentMethods=state.paymentMethods.filter(x=>!isPaymentMonthMarker(x));save();
 }
}
const isRefundEntry=x=>x.refundEntry===true;
const refundEntries=()=>{
 const purchases=new Map(state.records.filter(x=>x.direction==='expense').map(x=>[x.id,x]));
 return (state.refunds||[]).map(refund=>{
  const purchase=refund.status==='matched'?purchases.get(refund.refundOf):null;
  const scope=purchase&&!['review','excluded','transfer'].includes(purchase.scope)?purchase.scope:'refund-unassigned';
  return {...refund,id:'refund-entry:'+refund.id,refundId:refund.id,refundEntry:true,refundStatus:refund.status,
   direction:'expense',amount:-n(refund.amount),status:refund.status==='excluded'?'excluded':'confirmed',
   scope,ledgerType:purchase?.ledgerType||'refund',category:'환불',
   subcategory:purchase?((LABEL[scope]||'사용처 미지정')+' · '+(purchase.category||'원결제 연결됨')):'원결제 미연결',
   payment:refund.payment||purchase?.payment||'',originalAmount:purchase?.amount??null};
 });
};
const ledgerEntries=()=>[...state.records.filter(x=>x.direction==='expense'),...refundEntries()];
const relevant=()=>ledgerEntries().filter(x=>x.status!=='excluded');
const filtered=(list)=>list.filter(x=>(period==='all'||x.date.slice(0,7)===period)&&(scopeFilter==='all'||x.scope===scopeFilter)&&(typeFilter==='all'||(typeFilter==='refund'?isRefundEntry(x):x.ledgerType===typeFilter))&&(paymentFilter==='all'||effectivePaymentMethod(x)===paymentFilter)&&(q===''||[x.merchant,x.category,x.subcategory,x.note,x.payment,x.bankPayment,x.date].join(' ').toLocaleLowerCase('ko').includes(q.toLocaleLowerCase('ko'))));
const monthlyOptions=()=>{
 const months=new Set([...state.records.map(x=>x.date.slice(0,7)),...(state.refunds||[]).map(x=>x.date.slice(0,7)),...(state.dailyLotto||[]).map(x=>x.date.slice(0,7))].filter(x=>/^20\d\d-\d\d$/.test(x)));
 for(let m=1;m<=12;m++)months.add(now().slice(0,4)+'-'+String(m).padStart(2,'0'));
 return ['<option value="all">전체 기간</option>',...[...months].sort().reverse().map(m=>'<option value="'+m+'"'+(m===period?' selected':'')+'>'+m.slice(0,4)+'년 '+Number(m.slice(5))+'월</option>')].join('');
};
const statusBadge=x=>x.status==='review'?'<span class="tag tag-warn">분류 대기</span>':x.status==='excluded'?'<span class="tag tag-muted">제외됨</span>':'<span class="tag tag-ok">분류 완료</span>';
const scopeBadge=x=>'<span class="tag tag-'+E(x.scope)+'">'+E(LABEL[x.scope]||'미분류')+'</span>';
/* Ledger totals use each charge/refund's own date. Purchase links only help
   reconciliation; the net purchase amount is informational, never deducted twice. */
const linkedRefunds=row=>(state.refunds||[]).filter(r=>r.status==='matched'&&r.refundOf===row.id);
const refundedAmount=row=>linkedRefunds(row).reduce((v,r)=>v+n(r.amount),0);
const netExpenseAmount=row=>n(row.amount)-refundedAmount(row);
const sum=list=>list.reduce((v,x)=>v+n(x.amount),0);
const reviewableExpense=x=>!isRefundEntry(x)&&x.status==='review';
const countedExpense=x=>x.status==='confirmed'&&x.scope!=='review'&&x.scope!=='excluded';
function setStatus(msg,kind='local'){
 const el=$('#save-indicator');if(el){el.textContent=msg;el.closest('.top-privacy')?.setAttribute('data-status',kind)}
}
function refreshSaveStatus(){setStatus(storageFailure||sync?.status.label||'이 브라우저에 저장됨',storageFailure?'error':sync?.status.kind||'local')}
function toast(text){
 const el=$('#toast');if(!el)return;el.textContent=text;el.classList.add('visible');
 clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),3100);
}
function statCard(label,value,foot,theme='',icon='▣'){
 return '<article class="stat-card '+theme+'"><div class="stat-card-top"><span>'+E(label)+'</span><b>'+icon+'</b></div><strong>'+won(value)+'</strong><small>'+E(foot)+'</small></article>';
}
function pageIntro(eyebrow,title,desc,right=''){
 return '<section class="page-head"><div><div class="eyebrow">'+E(eyebrow)+'</div><h1>'+E(title)+'</h1><p>'+desc+'</p></div>'+right+'</section>';
}
function topFilters(){
 const methods=paymentFilterChoices();
 const options=methods.map(([label,count])=>'<option value="'+E(label)+'"'+(paymentFilter===label?' selected':'')+'>'+E(label)+' ('+count+'건)</option>').join('');
 return '<div class="filter-row"><select id="period-filter" aria-label="조회 기간">'+monthlyOptions()+'</select>'+
 '<select id="scope-filter" aria-label="사용처"><option value="all">모든 사용처</option>'+Object.entries(LABEL).filter(([k])=>k!=='transfer'&&k!=='excluded').map(([k,v])=>'<option value="'+k+'"'+(scopeFilter===k?' selected':'')+'>'+v+'</option>').join('')+'<option value="refund-unassigned"'+(scopeFilter==='refund-unassigned'?' selected':'')+'>환불 · 사용처 미지정</option></select>'+
 '<select id="type-filter" aria-label="장부 유형"><option value="all">모든 지출 종류</option>'+Object.entries(GROUP).map(([k,v])=>'<option value="'+k+'"'+(typeFilter===k?' selected':'')+'>'+v+'</option>').join('')+'<option value="refund"'+(typeFilter==='refund'?' selected':'')+'>환불</option></select>'+
 '<select id="payment-filter" class="payment-filter" aria-label="결제수단별 조회"><option value="all">모든 결제수단</option>'+options+'</select>'+
 '<input id="query-filter" class="search" type="search" autocomplete="off" placeholder="거래처 · 메모 · 결제수단 검색" value="'+E(q)+'"></div>';
}
/* Situation board visualizations are derived at render time; never persist
   aggregates or alter underlying ledger rows. Period controls every figure. */
let dashboardPayMetric='amount',dashboardPayAll=false;
const dashWonShort=value=>{
 const amount=Math.abs(n(value)),sign=n(value)<0?'−':'';
 if(amount>=100000000)return sign+(amount/100000000).toLocaleString('ko-KR',{maximumFractionDigits:1})+'억원';
 if(amount>=10000)return sign+(amount/10000).toLocaleString('ko-KR',{maximumFractionDigits:1})+'만원';
 return sign+Math.round(amount).toLocaleString('ko-KR')+'원';
};
function dashRankList(entries,limit=8,metric='amount'){
 const sorted=entries.slice().sort((a,b)=>(b[metric]||0)-(a[metric]||0)||a.name.localeCompare(b.name,'ko'));
 const top=sorted.slice(0,limit),remaining=sorted.slice(limit);
 if(remaining.length)top.push({name:'그 외 '+remaining.length+'개',amount:sum(remaining),count:remaining.reduce((v,x)=>v+x.count,0),isOther:true});
 const max=Math.max(1,...top.filter(x=>!x.isOther).map(x=>n(x[metric])));
 return top.length?'<div class="md-rank-list">'+top.map((row,index)=>{
   const amount=n(row[metric]),percent=amount>0?Math.max(2,Math.min(100,amount/max*100)):0;
   const barClass=row.isOther?'other':index===0?'first':'';
   return '<div class="md-rank-entry"><div class="md-rank-head"><span title="'+E(row.name)+'">'+E(row.name)+'</span>'+
     '<strong title="'+E(won(row.amount))+' / '+row.count+'건">'+(metric==='count'?row.count.toLocaleString('ko-KR')+'건':dashWonShort(row.amount))+'</strong></div>'+
     '<div class="md-rank-track"><i class="'+barClass+'" style="width:'+percent.toFixed(2)+'%"></i></div>'+
     '<div class="md-rank-sub">'+won(row.amount)+' <span>· '+row.count.toLocaleString('ko-KR')+'건</span></div></div>';
 }).join('')+'</div>':'<div class="empty">해당 기간에 확인된 지출이 없습니다.</div>';
}
function dashboard(){
 if(GagebuValidation.empty(state))return pageIntro('MONEY DESK','가계부','개인 · 편의점 · 풍월관의 돈 흐름을 한곳에서 관리하세요.')+
 '<section class="surface welcome"><span class="welcome-mark">₩</span><h2>오늘의 거래부터 가볍게 시작하세요</h2><p>날짜 · 금액 · 거래처만 입력하면 저장됩니다.<br>기존 장부가 있다면 JSON 백업이나 은행 엑셀을 가져오세요.</p><div class="quick-actions"><button class="btn primary" id="dashboard-new-record">＋ 첫 거래 입력</button><button class="btn" data-nav="import">기존 자료 가져오기</button></div></section>'+
 '<div class="start-guide"><article><b>01 · 입력</b><p>한 건은 간편 입력, 여러 건은 표에 붙여넣기</p><button class="row-edit" data-nav="sheet">여러 건 입력 →</button></article><article><b>02 · 관리</b><p>개인·편의점·풍월관을 나누고 환불까지 대조</p><button class="row-edit" data-nav="records">거래내역 →</button></article><article><b>03 · 보관</b><p>이 기기에 자동 보관하고 서버 연결 후 기기 간 동기화</p><button class="row-edit" data-nav="settings">저장 상태 확인 →</button></article></div>';
 const all=relevant().filter(x=>period==='all'||x.date.slice(0,7)===period);
 const confirmed=all.filter(countedExpense);
 const pending=all.filter(x=>reviewableExpense(x)||!isRefundEntry(x)&&x.scope==='review'&&n(x.amount)!==0);
 const purchases=confirmed.filter(x=>!isRefundEntry(x)),refunds=confirmed.filter(isRefundEntry);
 const unassignedRefunds=refunds.filter(x=>x.scope==='refund-unassigned');
 const fin=financials(period);
 const total=fin.expenses,personal=confirmed.filter(x=>x.scope==='personal');
 const business=confirmed.filter(x=>x.scope==='business'),windmoon=confirmed.filter(x=>x.scope==='windmoon');
 const other=confirmed.filter(x=>!['personal','business','windmoon'].includes(x.scope));
 const storeIncome=revenueTotal('store',period),lottoIncome=revenueTotal('lotto',period);
 const paymentMap=new Map(),categoryMap=new Map(),merchantMap=new Map();
 const addGroup=(map,key,amount,label)=>{
   const entry=map.get(key)||{name:label||key,amount:0,count:0};
   entry.amount+=amount;entry.count++;map.set(key,entry);
 };
 for(const x of confirmed){
   const amount=n(x.amount);
   let payment=isOnnuri(x)?'온누리상품권':String(x.payment||'').trim();
   if((!payment||/^(?:카드|체크카드|신용카드|계좌이체|자동이체)$/i.test(payment))&&x.bankPayment)
     payment=String(x.bankPayment).trim();
   payment=paymentLabelKey(payment);
   if(!payment||isPaymentMonthMarker(payment))payment='결제수단 미기재';
   addGroup(paymentMap,payment,amount);
   addGroup(categoryMap,String(x.category||'미분류'),amount);
   const merchantKey=G.normalizeMerchant(x.merchant||'')||'거래처미기재';
   addGroup(merchantMap,merchantKey,amount,String(x.merchant||'거래처 미기재').trim()||'거래처 미기재');
 }
 const payments=[...paymentMap.values()],categories=[...categoryMap.values()],merchants=[...merchantMap.values()];
 const onnuri=confirmed.filter(isOnnuri),onnuriAmount=sum(onnuri);
 const fixedAmount=sum(confirmed.filter(x=>x.ledgerType==='fixed'));
 const consumptionAmount=sum(confirmed.filter(x=>x.ledgerType==='consumption'));
 const latest=all.slice().sort((a,b)=>b.date.localeCompare(a.date)||String(b.time||'').localeCompare(String(a.time||''))).slice(0,8);
 const scopeTotal=sum(purchases);
 const scopes=[['personal','개인','#477fb4'],['business','편의점','#138a74'],['windmoon','풍월관','#8972c7'],['other','기타','#9caeb3']].map(([scope,name,color])=>{
   const rows=purchases.filter(x=>scope==='other'?!['personal','business','windmoon'].includes(x.scope):x.scope===scope);
   return {name,amount:sum(rows),count:rows.length,color};
 });
 let cursor=0;
 const gradient=scopeTotal>0?scopes.filter(x=>x.amount>0).map(row=>{
   const start=cursor;cursor+=row.amount/scopeTotal*100;
   return row.color+' '+start.toFixed(3)+'% '+Math.min(100,cursor).toFixed(3)+'%';
 }).join(','):'#e7eeeb 0% 100%';
 const scopeChart='<div class="md-scope-chart"><div class="md-donut" role="img" aria-label="지출 사용처 구성비" style="background:conic-gradient('+gradient+')">'+
   '<div class="md-donut-inner"><span>환불 차감 전</span><strong>'+dashWonShort(scopeTotal)+'</strong></div></div>'+
   '<div class="md-donut-legend">'+scopes.map(row=>'<div><i style="background:'+row.color+'"></i><span>'+E(row.name)+'</span><strong>'+dashWonShort(row.amount)+'</strong>'+
     '<small>'+(!scopeTotal?'0':(row.amount/scopeTotal*100).toFixed(1))+'% · '+row.count+'건</small></div>').join('')+'</div></div>';
 const trendSources=[...state.records,...refundEntries()].filter(x=>/^\d{4}-\d{2}/.test(String(x.date||''))&&x.status!=='excluded'&&
   (x.direction==='expense'||x.direction==='income'&&['가게 매출','토토 수수료'].includes(x.category)));
 const knownMonths=[...new Set([...trendSources.map(x=>x.date.slice(0,7)),...(state.dailyLotto||[]).map(x=>x.date.slice(0,7))])].sort();
 const endMonth=period==='all'?(knownMonths.at(-1)||ym()):period;
 const y=Number(endMonth.slice(0,4)),m=Number(endMonth.slice(5));
 const trendMonths=Array.from({length:12},(_,i)=>{
   const dt=new Date(Date.UTC(y,m-12+i,1));return dt.toISOString().slice(0,7);
 });
 const trendEntries=trendMonths.map(month=>{
   const value=financials(month);return {month,income:value.income,expense:value.expenses,balance:value.balance};
 });
 const trendMax=Math.max(1,...trendEntries.flatMap(x=>[x.income,Math.abs(x.expense)]));
 const monthlyChart='<div class="md-trend-legend"><span><i class="income"></i>수입</span><span><i class="expense"></i>순지출</span><small>단위: 원 · 최근 12개월</small></div>'+
   '<div class="md-trend-scroll"><div class="md-trend-grid">'+trendEntries.map(row=>{
     const incomeH=row.income>0?Math.max(2,row.income/trendMax*100):0;
     const expenseH=row.expense?Math.max(2,Math.abs(row.expense)/trendMax*100):0;
     const label=row.month.slice(2,4)+'/'+row.month.slice(5,7);
     return '<div class="md-month-column" title="'+E(row.month)+' · 수입 '+E(won(row.income))+' / 지출 '+E(won(row.expense))+' / 차이 '+E(won(row.balance))+'">'+
       '<div class="md-month-value">'+(row.income||row.expense?dashWonShort(Math.abs(row.expense)>row.income?row.expense:row.income):'')+'</div>'+
       '<div class="md-month-pair"><i class="income" style="height:'+incomeH.toFixed(2)+'%"></i><i class="expense'+(row.expense<0?' refund':'')+'" style="height:'+expenseH.toFixed(2)+'%"></i></div>'+
       '<span class="md-month-label">'+label+'</span><small class="'+(row.balance<0?'negative':'')+'">'+
       (row.income||row.expense?dashWonShort(row.balance):'—')+'</small></div>';
   }).join('')+'</div></div>'+
   '<p class="md-chart-footnote">순지출은 분류 완료 결제액에서 해당 월의 환불을 차감합니다. 환불이 더 큰 달은 음수이며 녹색 막대로 표시합니다. 수입은 편의점 월 총매출 + 토토 확정 수수료입니다.</p>';
 const relevantMonths=[...new Set(state.records.filter(x=>x.direction==='income'&&x.status!=='excluded'&&x.category==='가게 매출').map(x=>x.date.slice(0,7)))].sort();
 const posMonth=period==='all'?(relevantMonths.at(-1)||null):period;
 const posGross=posMonth?revenueTotal('store',posMonth):0;
 const posLotto=posMonth?revenueTotal('lotto',posMonth):0;
 const profit=posMonth?storedProfit(posMonth):null;
 const lottoDaily=posMonth?monthlyLottoDays(posMonth):[];
 const pendingShare=all.length?pending.length/all.length*100:0;
 const largest=purchases.reduce((best,x)=>!best||n(x.amount)>n(best.amount)?x:best,null);
 const paymentButtons='<div class="md-segment">'+
   ['amount','count'].map(mode=>'<button type="button" data-dashboard-pay="'+mode+'" aria-pressed="'+(dashboardPayMetric===mode)+'" class="'+(dashboardPayMetric===mode?'active':'')+'">'+(mode==='amount'?'금액':'건수')+'</button>').join('')+'</div>';
 const paymentRank=dashRankList(payments,dashboardPayAll?1000:8,dashboardPayMetric);
 const head=pageIntro('MONEY DESK','가계부',
   '개인 · 편의점 · 풍월관의 수입과 지출을 한눈에 확인하세요.',
   '<div class="md-period-control"><label for="period-filter">조회 기간</label><select id="period-filter">'+monthlyOptions()+'</select></div>');
 return head+'<div class="quick-actions"><button class="btn primary" id="dashboard-new-record">＋ 거래 입력</button><button class="btn" data-nav="sheet">여러 건 한 번에 입력</button><button class="btn" data-nav="import">파일 가져오기</button></div>'+
 '<div class="md-status-strip"><span>확정 결제 <b>'+purchases.length.toLocaleString('ko-KR')+'건</b></span>'+
 '<span>미분류 <b>'+pending.length.toLocaleString('ko-KR')+'건</b> ('+pendingShare.toFixed(1)+'%)</span>'+ '<span>환불 <b>'+refunds.length+'건</b> 반영 · 원결제 미연결 <b>'+refunds.filter(x=>x.refundStatus!=='matched').length+'건</b></span>'+
 '<span>기간 <b>'+(period==='all'?'전체 기간':E(period))+'</b></span>'+
 '<button type="button" data-nav="review">미분류 검토 →</button></div>'+
 '<div class="md-kpi-grid primary-kpis">'+statCard('확정 수입',fin.income,'편의점 '+dashWonShort(storeIncome)+' · 토토 '+dashWonShort(lottoIncome),'teal','↗')+
 statCard('순지출',total,'결제 '+dashWonShort(fin.grossExpenses)+' − 환불 '+dashWonShort(fin.refunds),'blue','↘')+
 statCard('장부상 수지',fin.balance,'확정 수입 − 순지출 · 순이익 아님',fin.balance<0?'amber':'teal','≋')+'</div><div class="md-kpi-grid detail-kpis">'+
 statCard('개인 지출',sum(personal),personal.length.toLocaleString('ko-KR')+'건','blue','◉')+
 statCard('편의점 지출',sum(business),business.length.toLocaleString('ko-KR')+'건','teal','▤')+
 statCard('풍월관 지출',sum(windmoon),windmoon.length.toLocaleString('ko-KR')+'건','violet','◈')+
 statCard('온누리 사용액',onnuriAmount,onnuri.length.toLocaleString('ko-KR')+'건 · 충전액 제외','teal','₩')+
 statCard('미분류 대기액',sum(pending),pending.length.toLocaleString('ko-KR')+'건 · 확정 수지 제외','amber','?')+'</div>'+
 (refunds.length?'<div class="notice compact refund-period-note"><b>환불 '+refunds.length+'건 · '+won(fin.refunds)+' 차감 반영</b><p>환불은 실제 환불일에 반영합니다. 원결제 연결은 대조용이며 추가로 차감하지 않습니다.'+(unassignedRefunds.length?' 사용처 미지정 환불 '+unassignedRefunds.length+'건은 전체 순지출에 반영됩니다.':'')+'</p></div>':'')+
 '<div class="md-dashboard-grid"><section class="surface md-panel md-span-2"><div class="surface-head"><div><h2>월별 수입 · 지출 흐름</h2><p>'+
   (period==='all'?'전체 합계와 별개로 최근 12개월을 표시합니다.':'선택월까지의 12개월을 표시합니다.')+
   '</p></div><button type="button" class="btn subtle" data-nav="sales">월매출 관리</button></div>'+monthlyChart+'</section>'+
 '<section class="surface md-panel"><div class="surface-head"><div><h2>사용처별 결제 구성</h2><p>환불 차감 전 결제액 기준입니다.</p></div></div>'+
   scopeChart+'</section>'+
 '<section class="surface md-panel"><div class="surface-head"><div><h2>결제수단별 실제 사용</h2><p>온누리는 사용액만 계산하며, 동일 카드의 다른 표기는 합산합니다.</p></div>'+paymentButtons+'</div>'+
   paymentRank+
 (payments.length>8?'<button type="button" class="md-expand-payments" data-dashboard-expand-payments="1">'+
    (dashboardPayAll?'상위 8개만 보기':'전체 '+payments.length+'개 결제수단 보기')+'</button>':'')+
 '<div class="md-panel-footer">선택 기간 '+payments.length+'종 · 총 '+won(total)+' · '+confirmed.length+'건</div></section>'+
 '<section class="surface md-panel"><div class="surface-head"><div><h2>지출 항목 TOP 9</h2><p>대분류별 지출 금액 · 건수</p></div></div>'+dashRankList(categories,9)+
 '<div class="md-panel-footer">고정지출 '+dashWonShort(fixedAmount)+' · 소비지출 '+dashWonShort(consumptionAmount)+'</div></section>'+
 '<section class="surface md-panel"><div class="surface-head"><div><h2>많이 결제한 거래처</h2><p>같은 이름의 거래처를 합산한 상위 8곳</p></div></div>'+dashRankList(merchants,8)+'</section>'+
 '<section class="surface md-panel"><div class="surface-head"><div><h2>매출 · 입력 점검</h2><p>'+(posMonth?E(posMonth)+' 기준':'등록된 월매출이 없습니다.')+'</p></div>'+
 '<button type="button" class="btn subtle" data-nav="sales">매출 입력</button></div>'+
 '<div class="md-check-list"><div><span>편의점 월 총매출</span><strong>'+won(posGross)+'</strong></div>'+
 '<div><span>토토 월 확정 수수료</span><strong>'+won(posLotto)+'</strong></div>'+
 '<div><span>편의점 월 순이익 (참고)</span><strong>'+(profit===null?'미입력':won(profit))+'</strong></div>'+
 '<div><span>토토 일별 기록</span><strong>'+lottoDaily.length+'일</strong></div>'+
 '<div><span>결제 1건 평균</span><strong>'+dashWonShort(purchases.length?fin.grossExpenses/purchases.length:0)+'</strong></div>'+
 '<div><span>최대 단일 결제</span><strong>'+(largest?dashWonShort(largest.amount):'—')+'</strong></div></div>'+
 (largest?'<p class="md-check-detail">최대 지출: '+E(largest.merchant||'거래처 미기재')+' · '+E(largest.date)+'</p>':'')+
 '<button type="button" class="md-review-link" data-nav="review">미분류 '+pending.length+'건 바로 확인 →</button></section></div>'+
 '<section class="surface md-panel md-recent"><div class="surface-head"><div><h2>최근 거래</h2><p>선택한 기간 내 최근 8건 · 미분류 포함</p></div><button type="button" class="btn subtle" data-nav="records">전체 거래 보기</button></div>'+transactionTable(latest,true)+'</section>'+
 '<div class="md-disclosure">장부 지표는 입력 자료 기준이며 실제 은행 잔액·세후 순이익을 뜻하지 않습니다. 은행 간 이체·카드대금·온누리 충전액은 지출에 중복 계산하지 않으며 미분류 거래는 별도 표시합니다.</div>';
}
function transactionTable(items,compact=false){
 const rows=items.map(x=>{
  const refund=isRefundEntry(x),amount=n(x.amount),linked=refund?0:refundedAmount(x);
  const classification=refund?'<span class="tag tag-refund">환불</span>':x.status==='excluded'?statusBadge(x):scopeBadge(x);
  const details=refund?(x.refundStatus==='matched'?'원결제 연결됨 · 환불일 반영':'원결제 미연결 · 환불일 반영'):
    linked?'연결 환불 '+won(linked)+' · 환불일에 별도 반영':'';
  const management=refund?'<button class="row-edit" data-manage-refund="'+E(x.refundId)+'">연결 관리</button>':
    (x.status==='excluded'?'<button class="row-edit" data-restore-record="'+E(x.id)+'">복원</button> ':'')+'<button class="row-edit" data-edit="'+E(x.id)+'">수정</button>';
  return '<tr'+(refund?' class="refund-ledger-row"':'')+'><td class="date-col">'+E(x.date)+'<small>'+E(x.time||'')+'</small></td>'+
   '<td class="merchant-col"><strong>'+E(x.merchant||'거래처 미기재')+'</strong><small>'+E(refund?'환불 · '+(x.sourceSheet||SOURCE[x.source]||'직접 입력'):(x.source==='bank'?'뱅크샐러드':x.sourceSheet||SOURCE[x.source]||'직접 입력'))+'</small></td>'+
   '<td class="payment-col"><strong class="payment-main">'+E(paymentLabel(x))+'</strong>'+
    (!refund&&registeredCard(x)?'<small>뱅샐 원본 카드: '+E(registeredCard(x))+'</small>':'')+
    (!refund&&onnuriLinkedCard(x)?'<small>온누리 연동 카드 (사용자 확인): '+E(onnuriLinkedCard(x))+'</small>':'')+
    (!refund&&x.direction==='expense'?onnuriCheckbox(x,'table'):'')+'</td>'+
   '<td class="classification-col">'+classification+'<small class="cat-text">'+E([x.category,x.subcategory].filter(Boolean).join(' / ')||'미분류')+'</small>'+
    (!refund&&x.scope==='windmoon'&&x.category==='온라인쇼핑'?'<small class="platform-detail">구매처: '+E(G.platformFor(x.merchant))+'</small>':'')+'</td>'+
   '<td class="right amount-col">'+(amount<0?'+':'−')+won(Math.abs(amount))+(details?'<small>'+E(x.status==='excluded'?'집계 제외':details)+'</small>':'')+'</td><td class="row-actions">'+management+'</td></tr>';
 }).join('');
 return '<div class="table-scroll"><table class="records-table expense-table'+(compact?' compact':'')+'"><thead><tr><th>날짜 · 시간</th><th>거래처</th><th>결제 수단</th><th>분류</th><th class="right">금액</th><th>관리</th></tr></thead><tbody>'+
 (rows||'<tr><td colspan="6"><div class="empty">표시할 거래가 없습니다.</div></td></tr>')+'</tbody></table></div>';
}
function reviewCard(x,i){
 const online=x.category==='온라인쇼핑'||/온라인 쇼핑/.test(x.reason||'');
 const suggest=x.matchCandidate?'<span class="match-flag">원장에 유사한 거래가 있습니다 · 중복 확인 필요</span>':'';
 return '<article class="review-card" data-review-id="'+E(x.id)+'"><div class="review-index">'+String(i+1).padStart(2,'0')+'</div><div class="review-main"><div class="review-top"><strong>'+E(x.merchant||'거래처 미기재')+'</strong><span>−'+won(x.amount)+'</span></div>'+
 '<div class="review-metadata">'+E(x.date)+' · '+E(paymentLabel(x))+
  (registeredCard(x)?' (뱅샐 원본 카드: '+E(registeredCard(x))+')':'')+(onnuriLinkedCard(x)?' (온누리 연동 카드: '+E(onnuriLinkedCard(x))+')':'')+
  ' · '+E([x.bankMajor,x.bankMinor].filter(Boolean).join(' / '))+'</div>'+onnuriCheckbox(x,'review')+
 '<p class="review-reason">'+E(x.reason||'분류 확인 필요')+'</p>'+suggest+
 '<div class="review-choices"><button data-scope="personal" data-id="'+E(x.id)+'" class="choice personal"><b>1</b> 개인 소비</button>'+
 '<button data-scope="business" data-id="'+E(x.id)+'" class="choice business"><b>2</b> 편의점 매입</button>'+
 '<button data-scope="windmoon" data-id="'+E(x.id)+'" class="choice windmoon"><b>3</b> 풍월관</button>'+
 '<button data-edit="'+E(x.id)+'" class="choice secondary">세부 수정</button><button data-scope="exclude" data-id="'+E(x.id)+'" class="choice exclude">제외</button><button data-delete-record="'+E(x.id)+'" class="choice delete-choice">완전 삭제</button></div>'+
 (online?'<small class="online-help">구매처: '+E(G.platformFor(x.merchant))+' · 용도에 따라 개인 / 편의점 / 풍월관을 선택합니다.</small>':'')+
 '</div></article>';
}
function reviewPage(){
 const list=state.records.filter(x=>x.direction==='expense'&&reviewableExpense(x)&&(period==='all'||x.date.slice(0,7)===period)).sort((a,b)=>b.date.localeCompare(a.date));
 const online=list.filter(x=>x.category==='온라인쇼핑').length;
 const pendingRefunds=(state.refunds||[]).filter(x=>x.status==='review'&&(period==='all'||x.date.slice(0,7)===period));
 return pageIntro('REVIEW INBOX','분류가 필요한 거래','애매한 거래를 임의 분류하지 않았습니다. 개인·편의점·풍월관 버튼 중 하나를 누르면 즉시 해당 장부로 이동합니다.',
 '<select id="period-filter" aria-label="조회 기간">'+monthlyOptions()+'</select>')+
 '<div class="review-summary"><div><strong>'+list.length.toLocaleString('ko-KR')+'건</strong><span>분류 대기</span></div><div><strong>'+pendingRefunds.length.toLocaleString('ko-KR')+'건</strong><span>원결제 미연결 환불 · 금액 반영됨</span></div><div><strong>'+won(sum(list))+'</strong><span>미반영 검토 금액</span></div></div>'+
 '<div class="review-header"><div><h2>빠른 분류</h2><p>거래처와 결제수단을 보고 바로 선택하세요. 확정 후에도 거래내역에서 수정할 수 있습니다.</p></div><div class="shortcuts">개인 <kbd>1</kbd> 편의점 <kbd>2</kbd> 풍월관 <kbd>3</kbd></div></div>'+
 '<div class="review-list">'+(list.length?list.slice(reviewOffset,reviewOffset+35).map((x,i)=>reviewCard(x,reviewOffset+i)).join(''):'<div class="empty spacious"><b>지출 분류 대기 항목이 없습니다.</b><p>'+(pendingRefunds.length?'아래 확인이 필요한 카드 환불을 검토하세요.':'다음 뱅크샐러드 파일을 가져오면 새 검토 항목이 나타납니다.')+'</p></div>')+'</div>'+
 (list.length>35?'<div class="pager"><button class="btn" data-review-page="prev" '+(reviewOffset===0?'disabled':'')+'>이전</button><span>'+(reviewOffset+1)+'–'+Math.min(reviewOffset+35,list.length)+' / '+list.length+'</span><button class="btn" data-review-page="next" '+(reviewOffset+35>=list.length?'disabled':'')+'>다음</button></div>':'')+refundAuditPanel(true);
}

const SHEET_CATS={
 fixed:{
  '담배 발주':['KT&G','말보로','메비우스','던힐'],
  '발주':['쿠팡','상온','지마켓','주류','네이버','미스터파크','기타'],
  '가게':['임대료','전기료','통신료','보안업체','가맹비','점소모품','스포츠 토토','기타'],
  '집':['월세','전기료','통신료','수도세','가스요금'],
  '보험':['KB암보험','KB주가지수','메리츠','삼성화재','KB7년의약속','기타'],
  '건보/연금':['국민연금','건강보험'],
  '세금':['부가가치세','종합소득세','지방세','세무사 기장료'],
  '월정액':['11번가','쿠팡','지마켓','네이버','기타'],
  '기타':['카드연회비','가족회비','기타']
 },
 consumption:{
  // 13 BankSalad major groups with owner-defined simpler food/online subgroups.
  // '풍월관' is a local ownership marker, retained for Windmoon expense records.
  '온라인쇼핑':['쿠팡','지마켓','알리','11번가','네이버','구매처 미확인','풍월관'],
  '생활':['편의점','마트','미분류','생필품','생활서비스','목욕','가구/가전','풍월관'],
  '식비':['외식','배달','풍월관'],
  '문화/여가':['스포츠','전시/관람','미분류','풍월관'],
  '금융':['보험','이자/대출','세금/과태료','은행','카드','증권/투자','풍월관'],
  '주거/통신':['휴대폰','전기세','가스비','인터넷','풍월관'],
  '교통':['대중교통','택시','시외버스','풍월관'],
  '카페/간식':['커피/음료','아이스크림/빙수','디저트/떡','기타간식','베이커리','풍월관'],
  '의료/건강':['약국','종합병원','내과/가정의학','안과','정형외과','이비인후과','풍월관'],
  '여행/숙박':['숙박비','항공권','여행','해외결제','풍월관'],
  '뷰티/미용':['화장품','피부과','미분류','풍월관'],
  '경조/선물':['기부/헌금','풍월관'],
  '패션/쇼핑':['패션','풍월관']
 }
};
/* User-editable taxonomy. Stable scope/group IDs survive label renames. */
// Exact '결제수단' labels found in the uploaded BankSalad workbook; no account numbers.
const BANKSALAD_CARDS=['HI-POINT','쿠팡 와우 카드','The CLASSIC-Y','KB국민 톡톡 my point카드','현대카드M',
 'KB국민 트래블러스 체크카드_교통','KB국민 청춘대로 싱글 체크카드(RF)',
 'KB국민 nori 체크카드(RF)','트래블로그 체크 마스터','SOL트래블(체크)','위비트래블 체크카드'];
const BANKSALAD_EPAY=['카카오페이 머니','카카오페이 간편결제','네이버페이 간편결제',
 '네이버페이 간편결제(머니)','네이버페이 간편결제(포인트)',
 '토스 간편결제','페이코 간편결제','페이코포인트','네이버페이 머니'];
const BANKSALAD_ACCOUNTS=['KB우대저축-저축예금','KB마이핏통장','개인사업자 입출금통장',
 '입출금통장','저금통','듀얼K  입출금통장','세이프박스','주택청약종합저축','저축예금',
 '쏠편한 입출금통장(저축예금)','NH주거래우대통장(비대면실명확인)','WON 통장'];
const NON_BANKSALAD_METHODS=['현금/송금','온누리상품권','자동이체','계좌이체','현금'];
const TAX_PAYMENT_DEFAULTS=[...BANKSALAD_CARDS,...BANKSALAD_EPAY,...BANKSALAD_ACCOUNTS,...NON_BANKSALAD_METHODS];
// Remove only unused, untouched V2 placeholder presets when changing the baseline.
const PREVIOUS_TAX_PAYMENT_DEFAULTS=['현금','현금/송금','계좌이체','신용카드','체크카드',
 '온누리상품권','쿠팡 KB','신한 Hi-Point','신한 Classic Y'];
const PREVIOUS_CONSUMPTION_DEFAULTS={
 '편의점':['풍월관'],'식재료':['풍월관'],'외식/배달':['풍월관'],'병원/약국':['풍월관'],
 '건강/미용':['풍월관'],'쇼핑':['온라인','오프라인','풍월관'],
 '온라인쇼핑':['풍월관'],'여행':['풍월관'],'교통비':['풍월관'],'기타':['풍월관']
};
// Previously inherited BankSalad detail labels: no longer default dropdown choices.
const OLD_BANKSALAD_FOOD=['식재료','한식','패스트푸드','배달','치킨','고기','중식','아시아음식','풍월관'];
const OLD_BANKSALAD_ONLINE=['인터넷쇼핑','서비스구독','결제/충전','앱스토어','풍월관'];
function taxonomy(){
 if(!state.taxonomy||typeof state.taxonomy!=='object'||Array.isArray(state.taxonomy))state.taxonomy=JSON.parse(JSON.stringify(SHEET_CATS));
 if(!state.taxonomyAliases||!Array.isArray(state.taxonomyAliases))state.taxonomyAliases=[];
 if(!state.customLabels||typeof state.customLabels!=='object')state.customLabels={scopes:{},groups:{}};
 if(!state.customLabels.scopes)state.customLabels.scopes={};
 if(!state.customLabels.groups)state.customLabels.groups={};
 // When resetting local state, old custom labels must not remain in module-level objects.
 for(const k of Object.keys(LABEL))if(!['personal','business','windmoon','review','transfer','excluded'].includes(k))delete LABEL[k];
 for(const k of Object.keys(GROUP))if(!['fixed','consumption'].includes(k))delete GROUP[k];
 Object.assign(LABEL,{personal:'개인',business:'편의점',windmoon:'풍월관',review:'미분류',excluded:'제외',transfer:'이체'});
 Object.assign(GROUP,{fixed:'고정지출',consumption:'소비지출'});
 Object.assign(LABEL,state.customLabels.scopes);
 Object.assign(GROUP,state.customLabels.groups);
 for(const group of Object.keys(GROUP))if(!state.taxonomy[group])state.taxonomy[group]={};
 if(!Array.isArray(state.paymentMethods)||!state.paymentMethods.length)state.paymentMethods=[...TAX_PAYMENT_DEFAULTS];
 if(!Array.isArray(state.hiddenPaymentMethods))state.hiddenPaymentMethods=[];
 if(!state.paymentAliases||typeof state.paymentAliases!=='object'||Array.isArray(state.paymentAliases))state.paymentAliases={};
 return state.taxonomy;
}
/* One-time upgrade for existing V2 browsers: replace placeholders with BankSalad
   defaults while retaining any modified/custom/used categories and payment methods.
   This must NEVER modify manually classified historical transactions. */
function adoptBankSaladDefaults(){
 if(state.bankSaladBaselineVersion===2)return false;
 const tax=taxonomy(),old=tax.consumption||{},merged={};
 const used=new Set((state.records||[]).filter(x=>x.direction==='expense'&&x.ledgerType==='consumption'&&
   !(x.source==='bank'&&!x.manual&&x.status==='confirmed'&&x.bankMajor)).map(x=>x.category));
 for(const [rawMajor,subs] of Object.entries(SHEET_CATS.consumption)){
   const major=canonicalCategory('consumption',rawMajor,'').category||rawMajor;
   const saved=old[major]||old[rawMajor]||[];
   const previous=Array.isArray(saved)?saved:[];
   const deprecated=rawMajor==='식비'?OLD_BANKSALAD_FOOD:rawMajor==='온라인쇼핑'?OLD_BANKSALAD_ONLINE:[];
   // Keep manually added detail names, but don't retain former auto-generated
   // food-type / checkout-type defaults as selectable subcategories.
   const past=previous.filter(x=>!deprecated.includes(x)||subs.includes(x));
   merged[major]=[...new Set([...(merged[major]||[]),...subs,...past])];
 }
 for(const [major,subs] of Object.entries(old)){
   if(major in merged)continue;
   const baseline=PREVIOUS_CONSUMPTION_DEFAULTS[major];
   const unchanged=Array.isArray(baseline)&&
     JSON.stringify([...(subs||[])])===JSON.stringify(baseline);
   // Hide only unused original presets. Custom labels and actively used labels persist.
   if(unchanged&&!used.has(major))continue;
   merged[major]=Array.isArray(subs)?[...subs]:[];
 }
 tax.consumption=merged;
 // Offer marketplace vendors in the fixed '발주' group, too.
 const fixedName=canonicalCategory('fixed','발주','').category||'발주';
 if(Array.isArray(tax.fixed?.[fixedName])){
   tax.fixed[fixedName]=[...new Set([...SHEET_CATS.fixed.발주,...tax.fixed[fixedName]])];
 }
 const referenced=new Set((state.records||[]).map(x=>x.payment).filter(Boolean));
 const oldPlaceholders=new Set(PREVIOUS_TAX_PAYMENT_DEFAULTS.filter(x=>!NON_BANKSALAD_METHODS.includes(x)));
 const extra=(state.paymentMethods||[]).filter(x=>!oldPlaceholders.has(x)||referenced.has(x));
 state.paymentMethods=[...new Set([...TAX_PAYMENT_DEFAULTS,...extra])];
 // Existing manual choices remain untouched. Re-categorize only bank-origin
 // rows that were never manually confirmed, including unclassified review items.
 for(const row of state.records||[]){
   if(row.source!=='bank'||row.direction!=='expense'||row.ledgerType!=='consumption'||row.manual)continue;
   if(!row.bankMajor)continue;
   const [major,minor]=G.categoryFor(row.scope,row.bankMajor,row.bankMinor,row.merchant);
   Object.assign(row,canonicalCategory('consumption',major,minor));
   if(row.scope==='windmoon')row.subcategory='풍월관';
 }
 state.bankSaladBaselineVersion=2;
 return true;
}

function restoreBankSaladPresets(confirmAction=true){
 if(confirmAction&&!confirm('가계부용 소비 대분류 13개(식비: 외식/배달, 온라인쇼핑: 구매처별)와 뱅크샐러드 결제수단 32종을 목록에 추가할까요?\n직접 만든 분류와 기존 거래는 삭제하지 않습니다.'))return false;
 const prior=JSON.stringify(state),tax=taxonomy();
 for(const [rawMajor,subs] of Object.entries(SHEET_CATS.consumption)){
   const major=canonicalCategory('consumption',rawMajor,'').category||rawMajor;
   tax.consumption[major]=[...new Set([...(tax.consumption[major]||[]),...subs])];
 }
 state.paymentMethods=[...new Set([...(state.paymentMethods||[]),...TAX_PAYMENT_DEFAULTS])];
 state.hiddenPaymentMethods=(state.hiddenPaymentMethods||[]).filter(x=>!TAX_PAYMENT_DEFAULTS.includes(x));
 state.bankSaladBaselineVersion=2;
 if(!save()){state=JSON.parse(prior);return false}
 render();toast('뱅크샐러드 기본 소비 분류·결제수단을 복원했습니다.');
 return true;
}

/* Verified from the user's 2026 Google Sheet '고정지출':
   fixed / 발주 has only 7 actually used subcategories through October 31.
   The previous template accidentally populated 15 unrequested vendors.
   Remove only those specific defaults from existing browsers, without changing
   recorded transactions, user-added names, or other categories. */
const UNUSED_FIXED_PURCHASE_PRESETS=[
 '알리','11번가','옥션','SSG','롯데온','컬리','테무','오늘의집','무신사',
 '인터파크','위메프','티몬','아이허브','29CM','온라인'
];
function trimUnusedPurchasePresets(){
 if(state.fixedPurchasePresetVersion===1)return false;
 const tax=taxonomy(),major=canonicalCategory('fixed','발주','').category||'발주';
 const subs=tax.fixed?.[major];
 if(Array.isArray(subs)){
   const inUse=new Set(
     [...state.records,...sheetData.rows].filter(x=>
       x.direction==='expense'&&x.ledgerType==='fixed'&&x.category===major
     ).map(x=>x.subcategory)
   );
   // Keep entries if actually used within local V2 records. This avoids
   // discarding a newly used vendor not yet present in the source Sheet.
   tax.fixed[major]=subs.filter(x=>!UNUSED_FIXED_PURCHASE_PRESETS.includes(x)||inUse.has(x));
 }
 state.fixedPurchasePresetVersion=1;
 return true;
}


/* The user's 2026 sheet identifies 11번가 and 알리바바 in spending notes;
   쿠팡/지마켓/네이버 are also present in the working store order categories.
   Most legacy '쇼핑' rows omit the merchant, so remove only unsupported
   built-in marketplace suggestions, not historical or custom user entries.
   As new banksalad data is imported, missing merchants remain manually addable. */
const UNUSED_CONSUMPTION_ONLINE_PRESETS=[
 '옥션','SSG','롯데온','컬리','테무','오늘의집','무신사',
 '인터파크','위메프','티몬','아이허브','29CM'
];
function trimUnusedConsumptionOnlinePresets(){
 if(state.consumptionOnlinePresetVersion===1)return false;
 const tax=taxonomy(),major=canonicalCategory('consumption','온라인쇼핑','').category||'온라인쇼핑';
 const subs=tax.consumption?.[major];
 if(Array.isArray(subs)){
   const used=new Set(
     [...state.records,...sheetData.rows].filter(x=>
       x.direction==='expense'&&x.ledgerType==='consumption'&&x.category===major
     ).map(x=>x.subcategory).filter(Boolean)
   );
   for(const rule of Object.values(state.customRules||{})){
     if(rule.ledgerType==='consumption'&&rule.category===major&&rule.subcategory)used.add(rule.subcategory);
   }
   tax.consumption[major]=subs.filter(x=>!UNUSED_CONSUMPTION_ONLINE_PRESETS.includes(x)||used.has(x));
 }
 state.consumptionOnlinePresetVersion=1;
 return true;
}

const categoriesFor=group=>taxonomy()[group]||{};
const valueOptions=values=>values.map(s=>'<option value="'+E(s)+'"></option>').join('');
// Legacy sheet spellings of the same physical cards are counted together.
const PAYMENT_DISPLAY_ALIASES={'신한HI-POINT':'HI-POINT','신한클래식Y':'The CLASSIC-Y','쿠팡국민카드':'쿠팡 와우 카드'};
const paymentLabelKey=value=>{
 let label=String(value||'').trim();
 label=PAYMENT_DISPLAY_ALIASES[label]||label;
 const seen=new Set();
 for(let i=0;i<20&&state.paymentAliases?.[label]&&!seen.has(label);i++){
   seen.add(label);label=state.paymentAliases[label];
 }
 return label;
};
const isPaymentMonthMarker=value=>/^(?:[1-9]|1[0-2])$/.test(String(value||'').trim());
const isCardPayment=value=>BANKSALAD_CARDS.includes(value)||/(?:카드|체크카드|HI-POINT|CLASSIC-Y)/i.test(value);
// One consistent funding label for transactions, dashboard aggregates, and filters.
// "현금/송금" is intentionally not split: the original sheet does not distinguish them.
function effectivePaymentMethod(x){
 if(isOnnuri(x))return '온누리상품권';
 let pay=String(x.payment||'').trim();
 if((!pay||/^(?:카드|체크카드|신용카드)$/i.test(pay))&&x.bankPayment)pay=String(x.bankPayment).trim();
 const result=paymentLabelKey(pay);
 return result&&!isPaymentMonthMarker(result)?result:'결제수단 미기재';
}
function paymentFilterChoices(){
 const counts=new Map();
 for(const x of ledgerEntries()){
   if(x.direction!=='expense'||(page==='records'&&recordsMode==='excluded'?x.status!=='excluded':x.status==='excluded'))continue;
   const method=effectivePaymentMethod(x);
   counts.set(method,(counts.get(method)||0)+1);
 }
 return [...counts.entries()].sort(([a,c],[b,d])=>Number(!isCardPayment(a))-Number(!isCardPayment(b))||d-c||a.localeCompare(b,'ko'));
}
function paymentUsageCounts(){
 const counts=new Map();
 for(const r of state.records||[]){
   if(r.direction!=='expense'||r.status==='excluded')continue;
   // A prepaid Onnuri charge is a distinct funding method, not a credit-card charge.
   const raw=isOnnuri(r)?'온누리상품권':String(r.payment||r.bankPayment||'').trim();
   const name=paymentLabelKey(raw);
   if(!name||isPaymentMonthMarker(name))continue;
   counts.set(name,(counts.get(name)||0)+1);
 }
 return counts;
}
function paymentChoices(){
 taxonomy();
 const hidden=new Set((state.hiddenPaymentMethods||[]).map(paymentLabelKey));
 const counts=paymentUsageCounts();
 const available=new Set([
   ...(state.paymentMethods||[]),
   ...(state.records||[]).map(r=>r.direction==='expense'?(isOnnuri(r)?'온누리상품권':r.payment||r.bankPayment):'')
 ].map(paymentLabelKey).filter(x=>x&&!isPaymentMonthMarker(x)&&!hidden.has(x)));
 return [...available].sort((a,b)=>Number(!isCardPayment(a))-Number(!isCardPayment(b))||
   (counts.get(b)||0)-(counts.get(a)||0)||a.localeCompare(b,'ko'));
}
function canonicalCategory(group,category,subcategory){
 let major=String(category||''),minor=String(subcategory||'');
 for(const alias of state.taxonomyAliases||[]){
   if(alias.group!==group)continue;
   if(alias.type==='major'&&alias.from===major)major=alias.to;
   if(alias.type==='minor'&&alias.major===major&&alias.from===minor)minor=alias.to;
 }
 return {category:major,subcategory:minor};
}
function addInputCategories(rows,confirmNew=true){
 taxonomy();
 const additions=new Map(),payments=new Set();
 for(const row of rows){
   if(row.direction!=='expense')continue;
   const group=row.ledgerType,major=String(row.category||'').trim(),minor=String(row.subcategory||'').trim(),pay=String(row.payment||'').trim();
   if(!(group in GROUP)||!major)throw Error('지출 종류와 대분류를 확인하세요.');
   if(major.length>80||minor.length>80||pay.length>100)throw Error('분류나 결제수단 이름이 너무 깁니다.');
   const known=categoriesFor(group);
   if(!(major in known)){if(!additions.has(group+'|'+major))additions.set(group+'|'+major,{group,major,subs:new Set()})}
   if(minor&&!known[major]?.includes(minor)){
     const key=group+'|'+major;
     if(!additions.has(key))additions.set(key,{group,major,subs:new Set()});
     additions.get(key).subs.add(minor);
   }
   if(pay&&!paymentChoices().includes(pay))payments.add(pay);
 }
 const newMajors=[...additions.values()].filter(x=>!(x.major in categoriesFor(x.group))).map(x=>x.major);
 const newSubs=[...additions.values()].flatMap(x=>[...x.subs].map(v=>x.major+' / '+v));
 if(confirmNew&&(newMajors.length||newSubs.length||payments.size)){
   const txt=[newMajors.length?'새 대분류: '+newMajors.join(', '):'',
    newSubs.length?'새 소분류: '+newSubs.join(', '):'',
    payments.size?'새 결제수단: '+[...payments].join(', '):''].filter(Boolean).join('\n');
   if(!confirm('목록에 없는 항목을 등록하고 저장할까요?\n'+txt))return false;
 }
 for(const {group,major,subs} of additions.values()){
   if(!(major in taxonomy()[group]))taxonomy()[group][major]=[];
   for(const sub of subs)if(!taxonomy()[group][major].includes(sub))taxonomy()[group][major].push(sub);
 }
 for(const p of payments)state.paymentMethods.push(p);
 return true;
}
function validateTaxName(value){const v=String(value||'').trim();if(!v||v.length>80)throw Error('이름은 1~80글자로 입력하세요.');return v}
function editTax(action,group,major,minor,name){
 taxonomy();const next=action==='hide-major'||action==='hide-minor'?'':validateTaxName(name);
 const groupCats=categoriesFor(group);
 if(action==='add-major'){
   if(!GROUP[group]||next in groupCats)throw Error('이미 있거나 올바르지 않은 대분류입니다.');
   groupCats[next]=[];
 }else if(action==='rename-major'){
   if(!(major in groupCats)||next in groupCats)throw Error('대분류 이름이 중복되거나 존재하지 않습니다.');
   const entries=Object.entries(groupCats);state.taxonomy[group]=Object.fromEntries(entries.map(([c,v])=>[c===major?next:c,v]));
   for(const r of [...state.records,...sheetData.rows])if(r.ledgerType===group&&r.category===major)r.category=next;
   for(const rule of Object.values(state.customRules))if(rule.ledgerType===group&&rule.category===major)rule.category=next;
   for(const payee of Object.values(state.rentRecipients||{}))if(group==='fixed'&&payee.category===major)payee.category=next;
   for(const a of state.taxonomyAliases)if(a.type==='minor'&&a.group===group&&a.major===major)a.major=next;
   state.taxonomyAliases.push({type:'major',group,from:major,to:next});
 }else if(action==='hide-major'){
   if(!(major in groupCats))throw Error('대분류를 찾을 수 없습니다.');
   delete groupCats[major];
 }else if(action==='add-minor'){
   if(!Array.isArray(groupCats[major])||groupCats[major].includes(next))throw Error('소분류 이름이 중복되거나 대분류가 없습니다.');
   groupCats[major].push(next);
 }else if(action==='rename-minor'){
   if(!groupCats[major]?.includes(minor)||groupCats[major].includes(next))throw Error('소분류 이름이 중복되거나 존재하지 않습니다.');
   groupCats[major][groupCats[major].indexOf(minor)]=next;
   for(const r of [...state.records,...sheetData.rows])if(r.ledgerType===group&&r.category===major&&r.subcategory===minor)r.subcategory=next;
   for(const rule of Object.values(state.customRules))if(rule.ledgerType===group&&rule.category===major&&rule.subcategory===minor)rule.subcategory=next;
   state.taxonomyAliases.push({type:'minor',group,major,from:minor,to:next});
 }else if(action==='hide-minor'){
   if(!groupCats[major]?.includes(minor))throw Error('소분류를 찾을 수 없습니다.');
   groupCats[major].splice(groupCats[major].indexOf(minor),1);
 }else if(action==='rename-scope'||action==='rename-group'){
   const obj=action==='rename-scope'?LABEL:GROUP;
   if(!(group in obj)||Object.entries(obj).some(([k,v])=>k!==group&&v===next))throw Error('중복 이름이거나 알 수 없는 항목입니다.');
   obj[group]=next;state.customLabels[action==='rename-scope'?'scopes':'groups'][group]=next;
 }else if(action==='add-scope'||action==='add-group'){
   const obj=action==='add-scope'?LABEL:GROUP;
   if(Object.values(obj).includes(next))throw Error('이미 같은 이름이 있습니다.');
   const id=(action==='add-scope'?'owner-':'group-')+uid();
   obj[id]=next;state.customLabels[action==='add-scope'?'scopes':'groups'][id]=next;
   if(action==='add-group')state.taxonomy[id]={};
 }else if(action==='add-payment'){
   if(paymentChoices().includes(next))throw Error('동일한 결제수단이 있습니다.');
   state.paymentMethods.push(next);
   state.hiddenPaymentMethods=state.hiddenPaymentMethods.filter(x=>x!==next);
 }else if(action==='rename-payment'){
   if(paymentChoices().includes(next))throw Error('동일한 결제수단이 있습니다.');
   if(!paymentChoices().includes(major))throw Error('목록에 없는 결제수단입니다.');
   // Change the label in the selector without overwriting imported raw records.
   for(const row of state.records)if(row.source==='manual'&&paymentLabelKey(row.payment)===major)row.payment=next;
   for(const row of sheetData.rows)if(paymentLabelKey(row.payment)===major)row.payment=next;
   state.paymentAliases[major]=next;
   if(!state.paymentMethods.includes(next))state.paymentMethods.push(next);
   state.hiddenPaymentMethods=state.hiddenPaymentMethods.filter(x=>x!==next);
 }else if(action==='hide-payment'){
   if(!paymentChoices().includes(major))throw Error('결제수단을 찾을 수 없습니다.');
   state.paymentMethods=(state.paymentMethods||[]).filter(x=>paymentLabelKey(x)!==major);
   if(!state.hiddenPaymentMethods.includes(major))state.hiddenPaymentMethods.push(major);
 }else throw Error('알 수 없는 분류 편집입니다.');
 return true;
}
function categoriesPage(){
 taxonomy();
 const labelControls=(pairs,action)=>pairs.map(([id,label])=>
  '<form class="tax-line" data-tax-action="'+action+'" data-tax-group="'+E(id)+'"><code>'+E(id)+'</code>'+
  '<input name="value" maxlength="80" value="'+E(label)+'" required aria-label="'+E(label)+' 이름">'+
  '<button class="btn subtle" type="submit">이름 변경</button></form>').join('');
 const sections=Object.entries(GROUP).map(([group,title])=>
  '<section class="surface tax-section"><div class="surface-head"><div><h2>'+E(title)+' · 대분류/소분류</h2><p>이름 변경은 과거 기록에도 적용하며, 숨김은 새 입력 목록에서만 제외됩니다.</p></div></div>'+
  '<div class="tax-body">'+Object.entries(categoriesFor(group)).map(([major,subs])=>
   '<div class="tax-major"><form class="tax-line" data-tax-action="rename-major" data-tax-group="'+E(group)+'" data-tax-major="'+E(major)+'">'+
   '<b>대분류</b><input name="value" required maxlength="80" value="'+E(major)+'">'+
   '<button type="submit" class="btn subtle">이름 변경</button><button type="button" class="btn danger-outline" data-tax-hide="hide-major" data-tax-group="'+E(group)+'" data-tax-major="'+E(major)+'">숨기기</button></form>'+
   '<div class="tax-minors">'+subs.map(minor=>
    '<form class="tax-line" data-tax-action="rename-minor" data-tax-group="'+E(group)+'" data-tax-major="'+E(major)+'" data-tax-minor="'+E(minor)+'">'+
    '<span>소분류</span><input required name="value" maxlength="80" value="'+E(minor)+'">'+
    '<button type="submit" class="btn subtle">변경</button><button type="button" class="btn danger-outline" data-tax-hide="hide-minor" data-tax-group="'+E(group)+'" data-tax-major="'+E(major)+'" data-tax-minor="'+E(minor)+'">숨기기</button></form>').join('')+
   '<form class="tax-line tax-add" data-tax-action="add-minor" data-tax-group="'+E(group)+'" data-tax-major="'+E(major)+'"><span>소분류</span><input name="value" required maxlength="80" placeholder="새 소분류">'+
   '<button class="btn subtle" type="submit">＋ 추가</button></form></div></div>').join('')+
  '<form class="tax-line tax-add" data-tax-action="add-major" data-tax-group="'+E(group)+'"><b>대분류</b><input name="value" maxlength="80" required placeholder="새 대분류">'+
  '<button class="btn primary" type="submit">＋ 추가</button></form></div></section>').join('');
 const paymentUsage=paymentUsageCounts();
 const paymentRow=pay=>
  '<form class="tax-line" data-tax-action="rename-payment" data-tax-major="'+E(pay)+'"><span>'+
  (isCardPayment(pay)?'카드':BANKSALAD_EPAY.includes(pay)?'간편결제':BANKSALAD_ACCOUNTS.includes(pay)?'계좌':'결제방식')+'</span>'+
  '<input name="value" maxlength="80" required value="'+E(pay)+'">'+
  '<small class="payment-use-count">'+(paymentUsage.get(pay)||0).toLocaleString('ko-KR')+'건</small>'+
  '<button class="btn subtle" type="submit">이름 변경</button>'+
  '<button type="button" class="btn danger-outline" data-tax-hide="hide-payment" data-tax-major="'+E(pay)+'">숨기기</button></form>';
 const paymentOptions=paymentChoices();
 const paymentList='<h3 class="payment-group-heading">카드 · 사용 횟수순</h3>'+
  paymentOptions.filter(isCardPayment).map(paymentRow).join('')+
  '<h3 class="payment-group-heading">그 외 결제수단 · 사용 횟수순</h3>'+
  paymentOptions.filter(pay=>!isCardPayment(pay)).map(paymentRow).join('');
 return pageIntro('CATEGORY MANAGER','분류 관리','사용처·지출 종류·대분류·소분류·결제수단을 직접 관리합니다. 검색 입력에서 기존 항목을 선택하거나 새로운 이름을 저장할 수도 있습니다.')+
 '<section class="surface bank-baseline-info"><div class="surface-head"><div><h2>뱅크샐러드 기반 기본값</h2><p>소비지출 대분류 13개 · 식비는 외식/배달만 · 온라인쇼핑은 구매처별 · 결제수단은 원본 32종 및 수동 입력 5종</p></div>'+
 '<button type="button" class="btn subtle" id="restore-bank-presets">기본 분류 복원</button></div></section>'+
 '<div class="tax-grid"><section class="surface"><div class="surface-head"><h2>사용처</h2></div><div class="tax-body">'+labelControls(Object.entries(LABEL).filter(([id])=>!['transfer','excluded'].includes(id)),'rename-scope')+
 '<form class="tax-line tax-add" data-tax-action="add-scope"><b>새 사용처</b><input name="value" required maxlength="80" placeholder="사용처 추가"><button class="btn primary">＋ 추가</button></form></div></section>'+
 '<section class="surface"><div class="surface-head"><h2>지출 종류</h2></div><div class="tax-body">'+labelControls(Object.entries(GROUP),'rename-group')+
 '<form class="tax-line tax-add" data-tax-action="add-group"><b>새 지출 종류</b><input name="value" maxlength="80" required placeholder="지출 종류 추가"><button class="btn primary">＋ 추가</button></form></div></section></div>'+
 sections+'<section class="surface"><div class="surface-head"><div><h2>카드 · 결제수단</h2><p>카드와 그 외 결제방식을 각각 실제 지출 사용 횟수 순으로 정렬합니다. 같은 카드의 과거 별칭은 합산하고, 기존 거래의 원문은 보존합니다.</p></div></div>'+
 '<div class="tax-body">'+paymentList+'<form class="tax-line tax-add" data-tax-action="add-payment"><b>새 결제수단</b><input name="value" required maxlength="80" placeholder="결제수단 추가">'+
 '<button class="btn primary">＋ 추가</button></form></div></section>'+
 '<div class="notice"><b>원본 보존</b><p>분류 이름만 바꾸며 거래 금액은 변경되지 않습니다. 원본 카드 정보는 그대로 유지하고, 자동분류 규칙은 변경된 이름으로 연결합니다.</p></div>';
}
function handleTaxForm(form){
 const a=form.dataset.taxAction,g=form.dataset.taxGroup||'',major=form.dataset.taxMajor||'',minor=form.dataset.taxMinor||'';
 const value=String(new FormData(form).get('value')||'');
 const old=JSON.stringify(state);
 try{
   editTax(a,g,major,minor,value);
   if(!save()){state=JSON.parse(old);return}
   render();toast('분류 설정을 저장했습니다.');
 }catch(err){state=JSON.parse(old);toast(err.message)}
}


const SHEET_FIELDS=['date','amount','scope','ledgerType','category','subcategory','merchant','payment','note','onnuri'];
const SHEET_TITLES={date:'날짜',amount:'금액 (원)',scope:'사용처',ledgerType:'지출 종류',category:'대분류',subcategory:'소분류',merchant:'거래처',payment:'결제수단',note:'메모',onnuri:'온누리'};
const sheetData={rows:[],date:now(),limit:200};
function saveSheetDraft(){try{sessionStorage.setItem('gagebu-sheet-draft',JSON.stringify(sheetData))}catch{}}
function restoreSheetDraft(){
 try{const saved=JSON.parse(sessionStorage.getItem('gagebu-sheet-draft')||'null');
  if(saved&&Array.isArray(saved.rows)&&saved.rows.length<=sheetData.limit){sheetData.rows=saved.rows;if(GagebuValidation.date(saved.date))sheetData.date=saved.date}
 }catch{}
}
const sheetNewRow=()=>({date:sheetData.date,amount:'',scope:'personal',scopeManual:false,ledgerType:'consumption',category:'',subcategory:'',merchant:'',payment:'',note:'',onnuri:false,onnuriAuto:false,onnuriTouched:false});
const sheetOptions=(items,current)=>items.map(([val,label])=>'<option value="'+E(val)+'"'+(val===current?' selected':'')+'>'+E(label)+'</option>').join('');
function sheetSelectOptions(field,row){
 if(field==='scope')return sheetOptions(Object.entries(LABEL).filter(([id])=>!['transfer','excluded'].includes(id)),row.scope);
 if(field==='ledgerType')return sheetOptions(Object.entries(GROUP),row.ledgerType);
 if(field==='category')return sheetOptions([['','대분류 선택'],...Object.keys(categoriesFor(row.ledgerType)).map(c=>[c,c]),['__add__','＋ 새 대분류 추가']],row.category);
 return sheetOptions([['','소분류 선택 (선택)'],...(categoriesFor(row.ledgerType)[row.category]||[]).map(c=>[c,c])],row.subcategory);
}
function sheetCell(field,row,index){
 const v=String(row[field]??''),attrs='data-sheet-field="'+field+'" data-sheet-index="'+index+'" aria-label="'+(index+1)+'행 '+SHEET_TITLES[field]+'"';
 if(['scope','ledgerType','category'].includes(field))return '<select '+attrs+'>'+sheetSelectOptions(field,row)+'</select>';
 if(field==='onnuri')return '<label class="sheet-onnuri-choice" title="온누리상품권 결제 여부"><input '+attrs+' type="checkbox"'+(row.onnuri?' checked':'')+'></label>';
 if(field==='subcategory')return '<input '+attrs+' type="text" list="sheet-sub-'+index+'" placeholder="소분류 (선택)" value="'+E(v)+'"><datalist id="sheet-sub-'+index+'">'+
   (categoriesFor(row.ledgerType)[row.category]||[]).map(x=>'<option value="'+E(x)+'"></option>').join('')+'</datalist>';
 return '<input '+attrs+' type="'+(field==='date'?'date':'text')+'"'+(field==='amount'?' inputmode="numeric"':'')+
   (field==='payment'?' list="sheet-payment-choices"':'')+
   ' autocomplete="off" placeholder="'+(field==='merchant'?'거래처 입력':field==='amount'?'금액':field==='payment'?'결제수단 선택 또는 입력':'')+'" value="'+E(v)+'">';
}
function sheetRowMarkup(row,i){
 return '<tr data-sheet-row="'+i+'"><th scope="row">'+(i+1)+'</th>'+
   SHEET_FIELDS.map(field=>'<td data-sheet-col="'+field+'">'+sheetCell(field,row,i)+'</td>').join('')+
   '<td><button type="button" class="row-edit" data-sheet-delete="'+i+'" aria-label="'+(i+1)+'행 삭제">×</button></td></tr>';
}
function sheetPage(){
 if(!sheetData.rows.length)sheetData.rows=Array.from({length:10},sheetNewRow);
 return pageIntro('SHEET INPUT','시트형 일괄 입력','기존 엑셀형 입력창을 복구했습니다. 현금 발주·사업비 등 직접 기록할 지출을 여러 행에 작성하고 한 번에 저장합니다.')+
 '<section class="surface sheet-entry"><datalist id="sheet-payment-choices">'+valueOptions(paymentChoices())+'</datalist><div class="surface-head"><div><h2>지출 일괄 입력</h2><p>Enter·Tab·방향키로 셀 이동 · Excel에서 여러 칸 복사/붙여넣기 · 대분류에 따른 소분류 추천</p></div>'+
 '<label class="sheet-date-label">기본 날짜 <input id="sheet-default-date" type="date" value="'+E(sheetData.date)+'"></label></div>'+
 '<div class="sheet-entry-scroll" id="sheet-entry-scroll"><table class="sheet-entry-table" id="sheet-entry-table"><thead><tr><th>#</th>'+
 SHEET_FIELDS.map(f=>'<th>'+SHEET_TITLES[f]+'</th>').join('')+'<th>삭제</th></tr></thead><tbody>'+
 sheetData.rows.map(sheetRowMarkup).join('')+'</tbody></table></div>'+
 '<div class="sheet-toolbar"><div class="sheet-toolbar-left"><button class="btn" type="button" id="sheet-add-5">＋ 5행</button>'+
 '<button class="btn" type="button" id="sheet-add-20">＋ 20행</button><button class="btn subtle" type="button" id="sheet-remove-empty">빈 행 정리</button></div>'+
 '<span id="sheet-row-counter">'+sheetData.rows.filter(x=>String(x.amount).trim()).length+'건 입력 중</span>'+
 '<button class="btn primary" type="button" id="sheet-submit">✓ 작성된 거래 저장</button></div></section>'+
 '<div class="notice"><b>중복 및 수입 처리</b><p>등록 전에 같은 날짜·금액·거래처의 기존 거래를 확인합니다. 편의점 월매출과 토토 확정 수수료는 각각 별도 POS 입력 화면에서 기록하며 이 표에서는 지출만 입력합니다.</p></div>';
}
function readSheetCells(){
 const table=$('#sheet-entry-table');if(!table)return;
 const rows=Array.from(table.querySelectorAll('tbody tr'));
 sheetData.rows=rows.map((tr,index)=>{
   const prev=sheetData.rows[index]||{};
   const out={...prev,scopeManual:!!prev.scopeManual};
   for(const field of SHEET_FIELDS){
     const el=tr.querySelector('[data-sheet-field="'+field+'"]');
     out[field]=field==='onnuri'?!!el?.checked:(el?.value??'');
   }
   return out;
 });
 saveSheetDraft();
}
function syncSheetOnnuri(row,tr){
 if(!row||row.onnuriTouched)return;
 const suggestion=onnuriHistoryDefault(row.merchant,row.payment);
 row.onnuri=suggestion.checked;row.onnuriAuto=suggestion.auto;
 const checkbox=tr?.querySelector('[data-sheet-field="onnuri"]');
 if(checkbox)checkbox.checked=row.onnuri;
}
function rerenderSheet(focusIndex,focusField){
 const scroll=$('#sheet-entry-scroll'),top=scroll?.scrollTop,left=scroll?.scrollLeft;
 render();
 const next=$('[data-sheet-index="'+focusIndex+'"][data-sheet-field="'+focusField+'"]');
 if(scroll){const nowScroll=$('#sheet-entry-scroll');nowScroll.scrollTop=top;nowScroll.scrollLeft=left}
 next?.focus();
}
function sheetRowFromInput(row,i){
 const content=SHEET_FIELDS.some(k=>k==='onnuri'?!!row.onnuri:(!['date','scope','ledgerType'].includes(k)&&String(row[k]||'').trim()));
 if(!content)return null;
 const date=String(row.date||'').trim(),amount=numInput(row.amount),scope=String(row.scope||''),type=String(row.ledgerType||''),
  category=String(row.category||'').trim(),merchant=String(row.merchant||'').trim();
 const fail=msg=>{throw Error((i+1)+'행: '+msg)};
 if(!GagebuValidation.date(date)||date<'2026-01-01')fail('올바른 날짜를 입력하세요');
 if(!GagebuValidation.amount(amount)||amount<=0)fail('금액은 0보다 큰 원 단위 정수로 입력하세요');
 if(!(scope in LABEL)||['transfer','excluded'].includes(scope))fail('사용처를 선택하세요');
 if(!(type in GROUP))fail('지출 종류를 선택하세요');
 if(!category)fail('대분류를 선택하세요');
 if(!merchant)fail('거래처를 입력하세요');
 const value={id:'manual-sheet-'+uid(),date,time:'',amount,direction:'expense',scope,ledgerType:type,
  category,subcategory:String(row.subcategory||'').trim(),merchant,payment:String(row.payment||'').trim(),
  onnuri:!!row.onnuri,onnuriAuto:!!row.onnuriAuto,onnuriManual:!!row.onnuriTouched,
  note:String(row.note||'').trim(),status:scope==='review'?'review':'confirmed',manual:true,
  source:'manual',sourceSheet:'시트형 직접 입력',bankKey:''};
 normalizeWindmoon(value);
 Object.assign(value,canonicalCategory(value.ledgerType,value.category,value.subcategory));
 return value;
}
function submitSheet(){
 readSheetCells();
 let candidates;
 try{candidates=sheetData.rows.map(sheetRowFromInput).filter(Boolean)}
 catch(e){toast(e.message);return}
 if(!candidates.length){toast('작성한 거래가 없습니다.');return}
 const repeated=candidates.filter((x,i)=>candidates.some((y,j)=>i!==j&&x.date===y.date&&x.amount===y.amount&&G.normalizeMerchant(x.merchant)===G.normalizeMerchant(y.merchant)));
 const existing=candidates.filter(x=>state.records.some(y=>y.direction==='expense'&&y.status!=='excluded'&&y.date===x.date&&y.amount===x.amount&&G.normalizeMerchant(y.merchant)===G.normalizeMerchant(x.merchant)));
 const dupCount=new Set([...repeated,...existing].map(x=>x.id)).size;
 const message=candidates.length+'건 ('+won(sum(candidates))+')을 저장할까요?'+
 (dupCount?'\n주의: 날짜·금액·거래처가 같은 중복 의심 '+dupCount+'건이 있습니다.':'');
 if(!confirm(message))return;
 const previous=JSON.stringify(state);
 if(!addInputCategories(candidates))return;
 state.records.push(...candidates);
 if(!save()){state=JSON.parse(previous);return}
 sheetData.rows=Array.from({length:10},sheetNewRow);
 saveSheetDraft();
 render();toast(candidates.length+'건을 시트에서 저장했습니다.');
}
function pasteSheetGrid(e){
 const el=e.target.closest?.('[data-sheet-field]');if(!el)return;
 const raw=e.clipboardData?.getData('text/plain')||'';
 if(!raw.includes('\t')&&!raw.includes('\n'))return;
 const rows=raw.replace(/\r/g,'').replace(/\n$/,'').split('\n').map(line=>line.split('\t'));
 if(!rows.length)return;
 e.preventDefault();readSheetCells();
 const startIndex=Number(el.dataset.sheetIndex),startCol=SHEET_FIELDS.indexOf(el.dataset.sheetField);
 if(startCol<0)return;
 const need=startIndex+rows.length;
 if(need>sheetData.limit){toast('한 번에 최대 '+sheetData.limit+'행까지 입력할 수 있습니다.');return}
 while(sheetData.rows.length<need)sheetData.rows.push(sheetNewRow());
 for(let i=0;i<rows.length;i++)for(let j=0;j<rows[i].length;j++){
   const f=SHEET_FIELDS[startCol+j];if(!f)break;
   const v=rows[i][j];
   const entry=sheetData.rows[startIndex+i];
   if(f==='scope'&&!(v in LABEL))continue;
   if(f==='ledgerType'&&!(v in GROUP))continue;
   if(f==='category'&&!Object.keys(categoriesFor(entry.ledgerType)).includes(v))continue;
   if(f==='onnuri'){
     entry.onnuri=/^(?:1|true|yes|y|예|o|온누리|체크)$/i.test(String(v).trim());
     entry.onnuriTouched=true;entry.onnuriAuto=false;continue;
   }
   entry[f]=v;
 }
 for(let i=0;i<rows.length;i++)syncSheetOnnuri(sheetData.rows[startIndex+i]);
 rerenderSheet(startIndex,el.dataset.sheetField);
}
function sheetMove(e){
 // Handle keys before the browser moves focus. Korean IME confirmation must be ignored.
 if(page!=='sheet'||e.isComposing||e.keyCode===229||e.ctrlKey||e.metaKey||e.altKey)return false;
 const el=e.target.closest?.('[data-sheet-field]');
 if(!el||el.disabled||el.readOnly)return false;
 const key=e.key;
 if(!['Enter','Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(key))return false;
 const index=Number(el.dataset.sheetIndex),column=SHEET_FIELDS.indexOf(el.dataset.sheetField);
 if(column<0||!Number.isInteger(index)||index<0)return false;
 // For native text fields, allow caret movement until the beginning/end of the text.
 if((key==='ArrowLeft'||key==='ArrowRight')&&el.tagName!=='SELECT'){
   const start=el.selectionStart,end=el.selectionEnd,length=String(el.value||'').length;
   if(start!==null&&end!==null){
     if(start!==end)return false; // selection still needs normal keyboard handling
     if(key==='ArrowLeft'&&start>0)return false;
     if(key==='ArrowRight'&&end<length)return false;
   }
 }
 // Alt+Down opens a native dropdown; arrows without modifiers move between cells.
 let row=index,col=column;
 if(key==='Enter')row+=e.shiftKey?-1:1;
 else if(key==='ArrowDown')row++;
 else if(key==='ArrowUp')row--;
 else if(key==='ArrowRight')col++;
 else if(key==='ArrowLeft')col--;
 else if(key==='Tab')col+=e.shiftKey?-1:1;
 if(col>=SHEET_FIELDS.length){row++;col=0}
 if(col<0){row--;col=SHEET_FIELDS.length-1}
 if(row<0)return false;
 e.preventDefault();
 e.stopPropagation();
 const current=sheetData.rows[index];
 if(current)current[el.dataset.sheetField]=el.dataset.sheetField==='onnuri'?el.checked:el.value; // do not discard last edited cell
 if(row>=sheetData.limit){toast('한 번에 최대 '+sheetData.limit+'행까지 입력할 수 있습니다.');return true}
 while(row>=sheetData.rows.length){
   const newRow=sheetNewRow();
   sheetData.rows.push(newRow);
   const body=$('#sheet-entry-table tbody');
   if(body)body.insertAdjacentHTML('beforeend',sheetRowMarkup(newRow,sheetData.rows.length-1));
 }
 const next=$('[data-sheet-index="'+row+'"][data-sheet-field="'+SHEET_FIELDS[col]+'"]');
 if(next){next.focus({preventScroll:false});if(next.tagName==='INPUT'&&!['date','checkbox'].includes(next.type))next.select?.()}
 return true;
}
function sheetSelectChange(el){
 const tr=el.closest('tr');if(!tr)return;
 if(el.dataset.sheetField==='ledgerType'){
   const cat=tr.querySelector('[data-sheet-field="category"]'),sub=tr.querySelector('[data-sheet-field="subcategory"]');
   if(cat){cat.innerHTML=sheetSelectOptions('category',{ledgerType:el.value,category:''});cat.value=''}
   if(sub){sub.value='';const list=tr.querySelector('datalist');if(list)list.innerHTML=''}
 }else if(el.dataset.sheetField==='category'){
   const sub=tr.querySelector('[data-sheet-field="subcategory"]');
   if(sub){sub.value='';const list=tr.querySelector('datalist');if(list)list.innerHTML=(categoriesFor(tr.querySelector('[data-sheet-field="ledgerType"]').value)[el.value]||[]).map(v=>'<option value="'+E(v)+'"></option>').join('')}
 }
 // Do not overwrite a manually selected owner; only infer when owner is still default.
 const category=tr.querySelector('[data-sheet-field="category"]')?.value||'',
       scope=tr.querySelector('[data-sheet-field="scope"]');
 if(scope&&!sheetData.rows[Number(el.dataset.sheetIndex)]?.scopeManual&&el.dataset.sheetField==='category'){
   const nextScope=['발주','담배 발주','가게'].includes(category)?'business':'personal';
   scope.value=nextScope;
 }
 const selectedScope=scope?.value||'personal',sub=tr.querySelector('[data-sheet-field="subcategory"]');
 if(sub&&selectedScope==='windmoon')sub.value='풍월관';
 else if(sub&&sub.value==='풍월관'&&el.dataset.sheetField==='scope')sub.value='';
}

function refundAuditPanel(onlyReview=false){
 const visibleRefunds=new Set(filtered(refundEntries()).map(x=>x.refundId));
 const source=(state.refunds||[]).filter(r=>(!onlyReview||r.status==='review')&&
   (onlyReview||recordsMode==='review'?r.status==='review':recordsMode==='excluded'?r.status==='excluded':r.status!=='excluded')&&
   visibleRefunds.has(r.id)).sort((a,b)=>b.date.localeCompare(a.date));
 if(!source.length)return '';
 const matched=source.filter(r=>r.status==='matched'),unlinked=source.filter(r=>r.status==='review');
 const byId=new Map(state.records.map(x=>[x.id,x]));
 return '<section class="surface ledger-refund-section"><div class="surface-head"><div><h2>'+
   (onlyReview?'원결제 미연결 환불':'환불 · 취소 연결 관리')+'</h2>'+
   '<p>집계 제외한 건을 빼고 모든 환불은 환불일의 순지출에서 이미 차감됩니다. 원결제 연결은 대조용이며 추가로 차감하지 않습니다.</p></div></div>'+
   '<div class="ledger-refund-metrics"><div><span>원결제 연결됨</span><strong>'+matched.length+'건 · '+won(sum(matched))+'</strong></div>'+
   '<div><span>원결제 미연결 · 금액 반영됨</span><strong>'+unlinked.length+'건 · '+won(sum(unlinked))+'</strong></div></div>'+
   '<div class="table-scroll"><table class="records-table ledger-refund-table"><thead><tr><th>환불일</th><th>거래처</th>'+
   '<th>결제수단</th><th class="right">환불 금액</th><th>원결제 연결</th><th>관리</th></tr></thead><tbody>'+
   source.map(r=>{
     const original=byId.get(r.refundOf);
     return '<tr><td>'+E(r.date)+'</td><td>'+E(r.merchant||'거래처 미기재')+'</td>'+
       '<td>'+E(r.payment)+'</td><td class="right ledger-refund-positive">+'+won(r.amount)+'</td>'+
       '<td>'+(r.status==='matched'&&original?
         '<button type="button" class="row-edit" data-edit="'+E(original.id)+'">'+E(original.date)+' · 원결제 '+won(original.amount)+'</button>':
         '<span class="tag '+(r.status==='excluded'?'tag-muted':'tag-warn')+'">'+(r.status==='excluded'?'집계 제외':'원결제 미연결 · 금액 반영됨')+'</span>')+'</td><td><button class="row-edit" data-manage-refund="'+E(r.id)+'">연결 관리</button></td></tr>';
   }).join('')+'</tbody></table></div></section>';
}
function recordsPage(){
 const eligible=filtered(ledgerEntries());
 const counts={active:eligible.filter(x=>x.status!=='excluded').length,review:eligible.filter(reviewableExpense).length,excluded:eligible.filter(x=>x.status==='excluded').length};
 const entries=eligible.filter(x=>recordsMode==='excluded'?x.status==='excluded':recordsMode==='review'?reviewableExpense(x):x.status!=='excluded').sort((a,b)=>b.date.localeCompare(a.date)||String(b.time||'').localeCompare(String(a.time||'')));
 offset=Math.min(offset,Math.max(0,Math.ceil(entries.length/80)-1)*80);
 const confirmed=entries.filter(countedExpense),pending=entries.filter(x=>reviewableExpense(x)||!isRefundEntry(x)&&x.scope==='review'&&n(x.amount)!==0);
 const group=new Map(),merchant=new Map();
 if(paymentFilter!=='all')for(const x of entries){
   const name=[x.category||'미분류',x.subcategory||''].filter(Boolean).join(' / ');
   const obj=group.get(name)||{amount:0,count:0};obj.amount+=n(x.amount);obj.count++;group.set(name,obj);
   const shop=String(x.merchant||'거래처 미기재').trim()||'거래처 미기재';
   const prior=merchant.get(shop)||{amount:0,count:0};prior.amount+=n(x.amount);prior.count++;merchant.set(shop,prior);
 }
 const paymentBreakdown=paymentFilter==='all'?'':(()=>{
   const fmt=map=>[...map.entries()].sort((a,b)=>b[1].amount-a[1].amount).slice(0,5).map(([name,x])=>
     '<div class="payment-filter-breakdown-row"><span title="'+E(name)+'">'+E(name)+'</span><strong>'+won(x.amount)+'</strong><small>'+x.count+'건</small></div>').join('')||'<div class="empty">조회되는 거래가 없습니다.</div>';
   return '<div class="payment-filter-breakdown"><div class="payment-filter-breakdown-head"><b>'+E(paymentFilter)+' 사용 내역</b>'+
     '<span>전체 지출 '+won(sum(entries))+' · '+entries.length+'건</span>'+
     '<button type="button" class="btn subtle" id="clear-payment-filter">필터 해제</button></div>'+
     (paymentFilter==='현금/송금'?'<p class="payment-filter-notice">원본 시트에서 현금과 계좌송금을 합쳐 기록한 결제방식입니다. 담배·주류 발주, 월세·임대료 등이 포함되므로 전액 현금 소비를 의미하지 않습니다.</p>':'')+
     '<div class="payment-filter-breakdown-cols"><div><h3>어디에 많이 썼나 · 지출항목</h3>'+fmt(group)+'</div>'+
     '<div><h3>어디에 많이 썼나 · 거래처</h3>'+fmt(merchant)+'</div></div></div>';
 })();
 return pageIntro('TRANSACTIONS','전체 거래내역','결제와 환불을 실제 발생일 순서로 표시합니다. 환불은 원결제 연결 여부와 관계없이 해당 일자의 순지출에서 차감됩니다.',
 '<button class="btn primary" id="new-record">＋ 직접 입력</button>')+
 '<section class="surface records-surface">'+topFilters()+'<div class="record-modes" aria-label="거래 상태">'+[['active','전체 지출 · 환불'],['review','미분류'],['excluded','제외 내역']].map(([mode,label])=>'<button class="'+(recordsMode===mode?'selected':'')+'" aria-pressed="'+(recordsMode===mode)+'" data-record-mode="'+mode+'">'+label+' <span>'+counts[mode]+'</span></button>').join('')+'</div>'+
 '<div class="table-topline"><span>조회 결과 <b>'+entries.length.toLocaleString('ko-KR')+'건</b></span>'+
 '<strong>순지출 '+won(sum(confirmed))+(pending.length?' · 미분류 '+won(sum(pending)):'')+'</strong></div>'+
 paymentBreakdown+transactionTable(entries.slice(offset,offset+80))+
 '<div class="pager"><button class="btn" data-page-step="-1" '+(offset===0?'disabled':'')+'>이전</button><span>'+(entries.length?offset+1:0)+'–'+Math.min(offset+80,entries.length)+' / '+entries.length+'</span><button class="btn" data-page-step="1" '+(offset+80>=entries.length?'disabled':'')+'>다음</button></div></section>'+refundAuditPanel();
}
function openRefund(id){
 const row=state.refunds.find(x=>x.id===id);if(!row)return;
 activeRefund=id;
 $('#refund-editor-body').innerHTML='<div class="refund-summary"><div><span>'+E(row.date)+' · '+E(row.payment||'결제수단 미기재')+'</span><h3>'+E(row.merchant||'거래처 미기재')+'</h3></div><strong>+'+won(row.amount)+'</strong></div>'+
 '<div class="refund-body"><p>환불액은 환불일의 순지출에서 이미 차감됩니다. 원결제 연결은 대조용이며 연결·해제해도 전체 순지출을 추가로 바꾸지 않습니다.</p><label class="visually-hidden" for="refund-query">원결제 검색</label><input type="search" id="refund-query" placeholder="거래처 · 날짜 · 금액으로 검색" autocomplete="off"><div id="refund-candidates"></div></div>'+
 '<div class="refund-actions">'+(row.status==='matched'?'<button class="btn" data-refund-action="unlink">연결 해제</button>':'')+'<button class="btn" data-refund-action="'+(row.status==='excluded'?'restore':'exclude')+'">'+(row.status==='excluded'?'환불 집계 복원':'환불 집계 제외')+'</button><button class="btn" id="close-refund-secondary">닫기</button></div>';
 renderRefundCandidates();$('#refund-editor').showModal();
}
function renderRefundCandidates(){
 const refund=state.refunds.find(x=>x.id===activeRefund);if(!refund)return;
 const keyword=($('#refund-query')?.value||'').trim().toLocaleLowerCase('ko');
 const merchant=G.normalizeMerchant(refund.merchant||''),pay=paymentLabelKey(refund.payment||'');
 const candidates=state.records.filter(x=>x.direction==='expense'&&x.status!=='excluded'&&(!keyword||[x.merchant,x.date,x.amount,x.amount.toLocaleString('ko-KR'),x.payment].join(' ').toLocaleLowerCase('ko').includes(keyword)));
 const score=x=>(x.id===refund.refundOf?10000:0)+(merchant&&G.normalizeMerchant(x.merchant||'')===merchant?1000:0)+(pay&&paymentLabelKey(x.payment||'')===pay?100:0)+(x.amount===refund.amount?30:0)-Math.min(50,dateDiff(x.date,refund.date)/10);
 candidates.sort((a,b)=>score(b)-score(a)||b.date.localeCompare(a.date));
 $('#refund-candidates').innerHTML='<p class="refund-candidate-count">'+candidates.length+'건'+(candidates.length>25?' 중 가까운 거래 25건 표시 · 검색으로 좁혀보세요':'')+'</p>'+
 (candidates.slice(0,25).map(x=>{
  const other=linkedRefunds(x).filter(r=>r.id!==refund.id).reduce((v,r)=>v+r.amount,0),after=x.amount-other-refund.amount;
  return '<button type="button" class="refund-candidate'+(x.id===refund.refundOf?' selected':'')+'" data-refund-target="'+E(x.id)+'"><span><b>'+E(x.merchant||'거래처 미기재')+'</b><small>'+E(x.date)+' · '+E(paymentLabel(x))+'</small></span><span><b>'+won(x.amount)+'</b><small>연결 후 '+won(after)+(x.id===refund.refundOf?' · 현재 연결':'')+'</small></span></button>';
 }).join('')||'<div class="empty">검색한 원결제가 없습니다. 거래를 먼저 등록한 후 연결하세요.</div>');
}
function changeRefund(action,targetId=''){
 const refund=state.refunds.find(x=>x.id===activeRefund);if(!refund)return;
 if(action==='link'){
  const purchase=state.records.find(x=>x.id===targetId&&x.direction==='expense'&&x.status!=='excluded');if(!purchase)return;
  const other=linkedRefunds(purchase).filter(r=>r.id!==refund.id).reduce((v,r)=>v+r.amount,0);
  if(other+refund.amount>purchase.amount&&!confirm('연결 환불 합계가 원결제보다 '+won(other+refund.amount-purchase.amount)+' 많습니다. 환율 차액 등 실제 환불액이 맞다면 계속 연결할까요?'))return;
  Object.assign(refund,{status:'matched',refundOf:targetId,manual:true,reason:'원결제 직접 확인'});
 }else Object.assign(refund,{status:action==='exclude'?'excluded':'review',refundOf:'',manual:true,reason:action==='exclude'?'사용자가 집계 제외':'원결제 연결 확인 필요'});
 if(!save())return;
 $('#refund-editor').close();render();toast(action==='link'?'환불을 원결제에 연결했습니다.':action==='exclude'?'환불을 집계에서 제외했습니다.':'환불을 검토 대상으로 옮겼습니다.');
}
function excludeRecord(id){
 const row=state.records.find(x=>x.id===id);if(!row)return;
 row.previousScope=row.scope;row.status='excluded';row.manual=true;
 if(!save())return;
 $('#editor').close();render();toast('집계에서 제외했습니다. 제외 내역에서 다시 복원할 수 있습니다.');
}
function restoreRecord(id){
 const row=state.records.find(x=>x.id===id);if(!row)return;
 const scope=row.scope==='excluded'?(row.previousScope||'personal'):row.scope;
 if(patchRecord(id,{scope,status:scope==='review'?'review':'confirmed',manual:true}))toast('거래를 복원했습니다.');
}
function importPage(){
 return pageIntro('DATA IMPORT','금융내역 가져오기','모든 분석은 브라우저 내부에서만 실행됩니다. 민감한 금융 엑셀은 공개 GitHub나 외부 서버에 업로드하지 않습니다.')+
 '<div class="import-grid"><section class="surface upload-panel"><div class="step"><span>01</span><div><h2>뱅크샐러드 엑셀</h2><p>선택 기간 자료 분석 · 거래처 원문 보존 · 토토/투자/수입/불필요한 이체 제외</p></div></div>'+
 '<div class="bank-range"><strong>가져올 거래 기간</strong><small>시작일과 종료일 포함 · 선택 기간의 거래만 등록</small>'+
 '<label>시작일 <input id="bank-import-from" type="date" value="'+E(bankImportRange.from)+'"></label>'+
 '<label>종료일 <input id="bank-import-to" type="date" value="'+E(bankImportRange.to)+'"></label></div>'+
 '<label class="dropzone" id="bank-drop"><input id="bank-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"><span class="drop-icon">⇧</span><strong>뱅크샐러드 XLSX 선택</strong><small>엑셀 파일을 클릭하거나 여기에 끌어다 놓으세요</small></label>'+
 '<div class="import-detail"><span>기존 거래와 날짜·금액·결제수단을 대조해 중복을 줄입니다.</span><span>카드 재발급으로 사라진 거래는 기존 시트에서 보존합니다.</span></div></section>'+
 '<section class="surface upload-panel"><div class="step"><span>02</span><div><h2>JSON 안전 병합</h2><p>오래된 V2 백업이나 기존 시트 이관 JSON도 기존 장부를 덮어쓰지 않습니다. 같은 거래는 유지하고 없는 거래·날짜만 추가하며, 변경 전 복구용 JSON을 다운로드합니다.</p></div></div>'+
 '<label class="dropzone secondary-drop"><input id="legacy-file" type="file" accept=".json,application/json"><span class="drop-icon">▦</span><strong>가계부 JSON 파일 선택</strong><small>기존 구글 시트 · 데이터 백업 · 카드 환불 대조/기록 수정 패치</small></label>'+
 '<div class="notice compact"><b>기존 데이터 보존 · 전체 덮어쓰기 금지</b><p>오래된 파일을 선택해도 기존 거래, 직접 수정한 분류, 온누리 체크와 사용자 규칙은 유지됩니다. 동일 거래의 과거 분류는 자동으로 되돌리지 않습니다.</p></div></section></div>'+
 (preview?importPreview():importEmpty())+
 '<div class="notice"><b>전액을 자동으로 지출 처리하지 않습니다.</b><p>온누리상품권 충전, 카드대금 납부, 주식투자, 토토 운영대금과 고객 송금은 제외합니다. 월세·가게 임대료는 확인된 수취인·금액만 예외 처리합니다.</p></div>';
}
function importEmpty(){return '<section class="surface import-placeholder"><div class="placeholder-icon">◎</div><h2>파일을 선택하면 정리 결과가 표시됩니다</h2><p>신규 거래 / 기존 장부 연결 / 미분류 / 제외 사유를 저장 전에 확인할 수 있습니다.</p></section>'}
function importPreview(){
 const p=preview;
 const summary=Object.entries(p.skips).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>'<div class="summary-line"><span>'+E(k)+'</span><strong>'+v.toLocaleString('ko-KR')+'건</strong></div>').join('');
 return '<section class="surface"><div class="surface-head"><div><h2>가져오기 미리보기</h2><p>'+E(p.fileName)+' · '+E(p.range.from)+' ~ '+E(p.range.to)+' · 기간 밖 '+p.outOfRange+'건 제외</p></div><span class="tag tag-ok">브라우저 내 분석 완료</span></div>'+
 '<div class="import-stats"><div><strong>'+p.total.toLocaleString('ko-KR')+'</strong><span>분석한 행</span></div><div><strong>'+p.newItems.length.toLocaleString('ko-KR')+'</strong><span>신규 등록 후보</span></div><div><strong>'+p.links.length.toLocaleString('ko-KR')+'</strong><span>기존 시트 연결 후보</span></div><div><strong>'+p.reviewCount.toLocaleString('ko-KR')+'</strong><span>신규 미분류</span></div></div>'+
 '<div class="import-review"><div><h3>자동 제외 내역 (건수만 집계, 거래 원문 미저장)</h3>'+summary+'</div><div><h3>신규 거래 미리보기</h3>'+p.newItems.slice(0,8).map(x=>'<div class="sample-line"><span>'+E(x.merchant)+' <small>'+E(x.date)+'</small></span><b>'+won(x.amount)+'</b></div>').join('')+'</div></div>'+
 '<div class="import-actions"><span class="bank-refund-info">환불 '+(p.refunds||[]).length+'건 · 자동 연결 '+(p.refunds||[]).filter(x=>x.status==='matched').length+'건 · 확인 필요 '+(p.refunds||[]).filter(x=>x.status==='review').length+'건</span>'+
 '<button class="btn subtle" id="discard-import">미리보기 취소</button><button class="btn primary" id="commit-bank">거래 '+p.newItems.length+'건 / 환불 '+(p.refunds||[]).length+'건 등록</button></div></section>';
}
function rulesPage(){
 const fixed=[
 ['스포츠토토 관련','모든 입·출금 수집 제외','토토 운영대금·당첨금 송금 및 미확인 개인 송금은 지출로 계산하지 않음'],
 ['온누리 충전','선불 충전 거래 제외','실제 사용 건과 충전액을 동시에 소비로 계산하지 않음'],
 ['주식·증권·투자','전체 제외','자산 거래는 가계부 소비 지출에서 배제'],
 ['집 월세','원본 장부와 수취인·날짜·금액 대조','개인 / 고정지출 / 집 → 월세'],
 ['편의점 임대료','원본 장부와 수취인·날짜·금액 대조','편의점 / 고정지출 / 가게 → 임대료'],
 ['다이소','전부 풍월관','거래처 위치 무관하게 풍월관으로 자동 분류'],
 ['편의점 (강동 외)','풍월관 자동','지점명이 종로·을지로 등 강동 외 지역으로 확인될 때만'],
 ['식당·카페 (강동 외)','풍월관 자동','배민·요기요·쿠팡이츠 등 배달은 제외'],
 ['온라인 쇼핑몰','세 가지 버튼으로 직접 선택','개인 소비 / 편의점 매입 / 풍월관 중 거래별로 결정']
 ];
 return pageIntro('CLASSIFICATION RULES','자동 분류 기준','자동 확정은 거래처·지역이 명확할 때만 시행합니다. 점포 위치가 나오지 않는 거래는 미분류로 남깁니다.')+
 '<section class="surface"><div class="surface-head"><div><h2>현재 적용 규칙</h2><p>이름만 보고 강동구 밖이라고 추정하거나 모든 쿠팡 거래를 사업비로 지정하지 않습니다.</p></div></div><div class="rule-list">'+fixed.map(([title,when,desc],i)=>'<div class="rule-item"><span class="rule-index">'+String(i+1).padStart(2,'0')+'</span><div><h3>'+E(title)+'</h3><strong>'+E(when)+'</strong><p>'+E(desc)+'</p></div></div>').join('')+'</div></section>'+
 '<section class="surface"><div class="surface-head"><div><h2>직접 확정한 거래처 규칙</h2><p>온라인 쇼핑몰은 같은 가맹점의 결제 목적이 매번 달라 자동 규칙 저장 대상이 아닙니다.</p></div></div>'+
 (Object.keys(state.customRules).length?'<div class="saved-rules">'+Object.entries(state.customRules).map(([key,value])=>'<div class="rule-saved"><span>'+E(key)+'</span><strong>'+E(LABEL[value.scope]||'')+'</strong><button class="row-edit" data-remove-rule="'+E(key)+'">삭제</button></div>').join('')+'</div>':'<div class="empty">직접 등록한 거래처별 규칙이 없습니다.</div>')+'</section>';
}

/* Monthly revenue is entered manually, separately from BankSalad expense imports.
   An existing v1 income transaction for that month is updated, not duplicated. */
const SALES={
 store:{category:'가게 매출',label:'편의점 월매출'},
 lotto:{category:'토토 수수료',label:'토토 월매출 · 확정 수수료'}
};
const monthEnd=month=>month+'-'+String(new Date(Number(month.slice(0,4)),Number(month.slice(5)),0).getDate()).padStart(2,'0');
const isMonth=month=>/^\d{4}-(?:0[1-9]|1[0-2])$/.test(String(month||''));
function findSales(month,type){
 const cat=SALES[type]?.category;
 return cat?state.records.filter(x=>x.direction==='income'&&x.category===cat&&x.date.slice(0,7)===month&&x.status!=='excluded'):[];
}
function salesValue(month,type){
 const entries=findSales(month,type);
 return {amount:sum(entries),count:entries.length,record:entries.length===1?entries[0]:null};
}

const storedProfit=month=>{
 const profit=state.storeProfits?.[month];
 return Number.isSafeInteger(profit)?profit:null;
};
const marginRate=(gross,profit)=>gross>0&&Number.isFinite(profit)?profit/gross*100:null;
const marginDisplay=(gross,profit)=>marginRate(gross,profit)===null?'—':marginRate(gross,profit).toFixed(2)+'%';
const monthlyLottoDays=month=>(state.dailyLotto||[]).filter(x=>x.date.slice(0,7)===month).sort((a,b)=>a.date.localeCompare(b.date));
const estimatedCommission=(handle,rate=state.lottoRatePct)=>Math.round(Number(handle)*Number(rate)/100);
function financials(selected=period){
 const income=revenueTotal('store',selected)+revenueTotal('lotto',selected);
 const expenses=relevant().filter(x=>countedExpense(x)&&(selected==='all'||x.date.slice(0,7)===selected));
 const refunds=expenses.filter(isRefundEntry),total=sum(expenses);
 return {income,expenses:total,balance:income-total,grossExpenses:sum(expenses.filter(x=>!isRefundEntry(x))),
  refunds:-sum(refunds),refundCount:refunds.length,
  unreviewed:sum(state.records.filter(x=>x.direction==='expense'&&reviewableExpense(x)&&(selected==='all'||x.date.slice(0,7)===selected)))};
}
function revenueTotal(type,selected=period){
 return sum(state.records.filter(x=>x.direction==='income'&&x.category===SALES[type].category&&x.status!=='excluded'&&(selected==='all'||x.date.slice(0,7)===selected)));
}
function upsertSale(month,type,amount,note,netProfit){
 if(!isMonth(month)||!SALES[type]||!GagebuValidation.amount(amount))throw Error('월·금액을 확인하세요.');
 const existing=findSales(month,type);
 if(existing.length>1)throw Error('같은 달에 같은 매출 기록이 여러 건 있습니다. 자동 덮어쓰지 않았습니다.');
 if(existing.length){
   const record=existing[0];
   Object.assign(record,{amount,note,scope:'business',status:'confirmed',manual:true});
   if(type==='store'&&netProfit!==undefined){if(netProfit===null)delete state.storeProfits[month];else state.storeProfits[month]=netProfit;}
   return 'updated';
 }
 if(type==='store'&&netProfit!==undefined){if(netProfit===null)delete state.storeProfits[month];else state.storeProfits[month]=netProfit;}
 state.records.push({id:'manual-monthly-'+type+'-'+month,date:monthEnd(month),time:'',amount,
   direction:'income',scope:'business',ledgerType:'',category:SALES[type].category,subcategory:'',
   merchant:type==='store'?'편의점 POS 월마감':'토토 POS 월마감',payment:'',
   note,source:'manual',sourceSheet:'사이트 월 마감',status:'confirmed',manual:true,bankKey:''});
 return 'created';
}

function salesPage(){
 const m=isMonth(salesMonth)?salesMonth:ym(),d={store:salesValue(m,'store'),lotto:salesValue(m,'lotto')};
 const profit=storedProfit(m),gross=d.store.amount,year=m.slice(0,4),f=financials(m);
 const lottoDays=monthlyLottoDays(m),lottoDaySum=sum(lottoDays.map(x=>({amount:x.commission})));
 const forms=Object.entries(SALES).map(([type,cfg])=>{
   const x=d[type],store=type==='store';
   return '<form class="sales-form" data-sale-type="'+type+'"><div class="sales-form-head"><div class="sales-type-icon '+type+'">'+(store?'▣':'◎')+
   '</div><div><h2>'+E(store?'편의점 월매출':'토토 월 확정 수수료')+'</h2><p>'+
   (store?'영수증의 총매출과 순이익을 입력합니다. 순이익은 수입에 중복 추가하지 않습니다.':
   '토토는 일별 판매액 전체가 아닌 월 확정 수수료만 수입에 반영합니다.')+'</p></div></div>'+
   '<div class="sales-current"><span>현재 확정 금액</span><strong>'+(x.count?won(x.amount):'미등록')+'</strong></div>'+
   (x.count>1?'<div class="sales-conflict">동일 월 매출이 여러 건입니다. 중복 확인 전 수정 불가.</div>':'')+
   '<label class="sales-input-label">월 '+(store?'총매출':'확정 수수료')+' (원)</label>'+
   '<input type="text" inputmode="numeric" name="amount" value="'+(x.count===1?E(x.amount.toLocaleString('ko-KR')):'')+'" placeholder="금액 입력" required>'+
   (store?'<label class="sales-input-label">월 순이익 (원)</label>'+
    '<input type="text" inputmode="numeric" id="sales-profit-input" name="netProfit" value="'+(profit===null?'':E(profit.toLocaleString('ko-KR')))+'" placeholder="영수증의 순이익">'+
    '<div class="sales-profit-preview"><span>순이익 ÷ 총매출</span><strong id="live-margin">'+marginDisplay(gross,profit)+'</strong></div>':
    '<div class="sales-profit-preview"><span>일별 수수료 '+lottoDays.length+'일 합계</span><strong>'+won(lottoDaySum)+'</strong></div>'+
    '<button type="button" class="btn subtle wide" data-nav="lotto">일별 판매액·수수료 입력 →</button>')+
   '<label class="sales-input-label">정산 메모 (선택)</label><input type="text" name="note" value="'+E(x.record?.note||'')+'" placeholder="POS 마감 메모">'+
   '<button class="btn primary wide" type="submit" '+(x.count>1?'disabled':'')+'>'+(x.count===1?'✓ 수정 저장':'＋ 등록')+' <span>→</span></button>'+ (x.count===1?'<button type="button" class="btn danger-outline wide" data-delete-record="'+E(x.record.id)+'">이 달 매출 삭제</button>':'')+'</form>';
 }).join('');
 const table=Array.from({length:12},(_,i)=>{
   const month=year+'-'+String(i+1).padStart(2,'0'),a=salesValue(month,'store'),b=salesValue(month,'lotto'),p=storedProfit(month);
   return '<tr><td><b>'+month+'</b></td><td class="right">'+(a.count?won(a.amount):'—')+'</td><td class="right">'+(p===null?'—':won(p))+
   '</td><td class="right">'+marginDisplay(a.amount,p)+'</td><td class="right">'+(b.count?won(b.amount):'—')+
   '</td><td class="right">'+(a.count||b.count?won(a.amount+b.amount):'—')+
   '</td><td><button type="button" class="row-edit" data-sales-select="'+month+'">수정</button></td></tr>';
 }).join('');
 return pageIntro('MONTHLY POS','월매출 입력','편의점은 월 총매출과 순이익을 입력하고 마진율을 자동 계산합니다. 장부 수지는 총매출 + 토토 확정 수수료 − 지출로 계산합니다.',
 '<label class="sales-month-control">정산 월 <input id="sales-month" type="month" value="'+E(m)+'"></label>')+
 '<div class="sales-metrics"><div><span>편의점 총매출</span><strong>'+won(gross)+'</strong></div>'+
 '<div><span>편의점 순이익</span><strong>'+(profit===null?'미등록':won(profit))+'</strong></div>'+
 '<div><span>편의점 마진율</span><strong>'+marginDisplay(gross,profit)+'</strong></div>'+
 '<div><span>토토 확정 수수료</span><strong>'+won(d.lotto.amount)+'</strong></div>'+
 '<div><span>수입 합계 (총매출 + 수수료)</span><strong>'+won(f.income)+'</strong></div>'+
 '<div><span>장부 수지 (수입 − 지출)</span><strong>'+won(f.balance)+'</strong></div></div>'+
 '<div class="sales-forms">'+forms+'</div>'+
 '<section class="surface"><div class="surface-head"><div><h2>'+year+'년 월별 수입</h2>'+
 '<p>토토는 월 확정 수수료만 합산하며 일별 수수료는 대조용입니다.</p></div></div>'+
 '<div class="table-scroll"><table class="records-table sales-history"><thead><tr><th>월</th><th class="right">총매출</th><th class="right">순이익</th><th class="right">마진율</th><th class="right">토토 수수료</th><th class="right">확정 수입 합계</th><th>관리</th></tr></thead><tbody>'+
 table+'</tbody></table></div></section>'+
 '<div class="notice"><b>계산 기준</b><p>편의점 순이익은 마진율 참고용입니다. 지출 차감 기준은 편의점 총매출과 토토 월 확정 수수료이며, 토토 판매액 전체·당첨금 지급·은행 입금 내역은 중복 합산하지 않습니다. 미분류 지출은 검토 후 반영됩니다.</p></div>';
}
function saveMonthlySale(form){
 const data=new FormData(form),type=form.dataset.saleType,amount=numInput(data.get('amount')),
   note=String(data.get('note')||'').trim();
 if(!GagebuValidation.amount(amount)){toast('월 금액은 0 이상의 원 단위 정수로 입력하세요.');return}
 let profit;
 if(type==='store'){
   const raw=String(data.get('netProfit')??'').trim();profit=raw===''?null:signedInput(raw);
   if(profit!==null&&!GagebuValidation.amount(Math.abs(profit))){toast('순이익을 올바르게 입력하세요.');return}
 }
 const before=JSON.stringify(state.records),beforeProfits=JSON.stringify(state.storeProfits);
 try{
   const mode=upsertSale(salesMonth,type,amount,note,profit);
   if(!save()){state.records=JSON.parse(before);state.storeProfits=JSON.parse(beforeProfits);return}
   render();toast((type==='store'?'편의점 총매출':'토토 확정 수수료')+' '+(mode==='updated'?'수정':'등록')+' 완료');
 }catch(err){state.records=JSON.parse(before);state.storeProfits=JSON.parse(beforeProfits);toast(err.message)}
}
function lottoPage(){
 const month=isMonth(lottoMonth)?lottoMonth:ym(),parts=month.split('-').map(Number),days=new Date(parts[0],parts[1],0).getDate();
 const daily=monthlyLottoDays(month),byDate=new Map(daily.map(x=>[x.date,x])),confirmed=salesValue(month,'lotto');
 const dayTotal=daily.reduce((a,x)=>a+x.commission,0),handleTotal=daily.reduce((a,x)=>a+x.handle,0);
 const complete=daily.length===days,maintenance=month==='2026-04';
 const entries=Array.from({length:days},(_,i)=>{
   const date=month+'-'+String(i+1).padStart(2,'0'),x=byDate.get(date),pause=maintenance&&i+1>=14&&i+1<=20;
   return '<tr data-lotto-date="'+date+'"'+(pause?' class="lotto-pause"':'')+'><td><b>'+String(i+1).padStart(2,'0')+'일</b><small>'+date+'</small>'+
    (pause?'<span class="lotto-pause-tag">발매 중단</span>':'')+'</td>'+
    '<td><input data-lotto-input="handle" type="text" inputmode="numeric" aria-label="'+date+' 판매액" value="'+(x?E(x.handle.toLocaleString('ko-KR')):'')+'" placeholder="판매액"></td>'+
    '<td><input data-lotto-input="commission" type="text" inputmode="numeric" aria-label="'+date+' 수수료" value="'+(x?E(x.commission.toLocaleString('ko-KR')):'')+'" placeholder="예상 자동계산"></td><td>'+(x?'<button type="button" class="row-delete" data-delete-lotto="'+date+'">삭제</button>':'—')+'</td></tr>';
 }).join('');
 return pageIntro('LOTTO DAILY','토토 일별 매출','2026년 4월 14~20일 발매 중단은 정상 0원 기록입니다. 일별 판매액과 실제 수수료를 입력하고, 월 확정 수수료와 대조합니다.',
 '<label class="sales-month-control">입력 월 <input id="lotto-month" type="month" value="'+month+'"></label>')+
 '<div class="sales-metrics lotto-metrics"><div><span>일별 판매액 합계</span><strong>'+won(handleTotal)+'</strong></div>'+
 '<div><span>일별 수수료 합계</span><strong>'+won(dayTotal)+'</strong></div>'+
 '<div><span>월 확정 수수료</span><strong>'+(confirmed.count?won(confirmed.amount):'미확정')+'</strong></div>'+
 '<div><span>일별 기록</span><strong>'+daily.length+' / '+days+'일</strong></div>'+
 '<div><span>일별·확정 차이</span><strong>'+(confirmed.count===1?won(dayTotal-confirmed.amount):'—')+'</strong></div>'+
 '<div><span>대조 상태</span><strong>'+(confirmed.count>1?'중복 확인 필요':confirmed.count===0?'미확정':dayTotal===confirmed.amount?'일치':'차이 확인')+'</strong></div></div>'+
 '<section class="surface"><div class="surface-head"><div><h2>'+month+' 판매액·수수료 입력</h2><p>실제 수수료가 비어 있으면 예상 비율로 계산하며, 기존 실제 입력값은 덮어쓰지 않습니다.</p></div>'+
 '<label class="lotto-rate">예상 수수료율 (%) <input id="lotto-rate" type="number" min="0" max="100" step="0.001" value="'+E(String(state.lottoRatePct??5.97))+'"></label></div>'+
 '<form id="lotto-daily-form"><div class="table-scroll"><table class="records-table lotto-day-table"><thead><tr><th>날짜</th><th>판매액 (원)</th><th>실제 수수료 (원)</th><th>관리</th></tr></thead><tbody>'+
 entries+'</tbody></table></div><div class="lotto-form-actions"><span>빈 날짜는 변경하지 않습니다. 0원은 정상 기록으로 저장 가능합니다.</span>'+
 '<button class="btn primary" type="submit">✓ 일별 기록 저장</button></div></form></section>'+
 '<section class="surface"><div class="surface-head"><div><h2>월 확정 수수료</h2><p>일별 수수료를 월 수입으로 확정합니다. 일별 판매액 전체는 수입에 포함하지 않습니다.</p></div></div>'+
 '<div class="lotto-confirm"><div class="summary-line"><span>일별 수수료 합계</span><strong>'+won(dayTotal)+'</strong></div>'+
 '<div class="summary-line"><span>월 확정 수수료</span><strong>'+(confirmed.count?won(confirmed.amount):'미확정')+'</strong></div>'+
 '<button class="btn primary" id="confirm-lotto" '+(!complete||confirmed.count>1?'disabled':'')+'>'+(confirmed.count?'일별 합계로 월 확정액 갱신':'일별 합계로 월 수수료 확정')+'</button>'+
 (!complete?'<p class="incomplete-warning">기록이 없는 '+(days-daily.length)+'일을 먼저 입력해야 월 확정이 가능합니다.</p>':'')+
 '<button class="btn subtle" data-nav="sales">월매출 입력 화면 →</button></div></section>';
}
function saveLottoDaily(form){
 const rows=$$('tr[data-lotto-date]',form),updates=[],errors=[];
 for(const tr of rows){
   const date=tr.dataset.lottoDate,hraw=$('[data-lotto-input="handle"]',tr).value.trim(),craw=$('[data-lotto-input="commission"]',tr).value.trim();
   if(!hraw&&!craw)continue;
   if(!hraw){errors.push(date+' 판매액을 입력하세요');continue}
   const handle=numInput(hraw),commission=craw===''?estimatedCommission(handle):numInput(craw);
   if(!GagebuValidation.amount(handle)||!GagebuValidation.amount(commission)){errors.push(date+' 금액 형식 오류');continue}
   updates.push({date,handle,commission,commissionEstimated:craw===''});
 }
 if(errors.length){toast(errors.slice(0,3).join(' / '));return}
 if(!updates.length){toast('저장할 날짜가 없습니다.');return}
 const before=JSON.stringify(state.dailyLotto),index=new Map(state.dailyLotto.map(x=>[x.date,x]));
 for(const v of updates){
   if(index.has(v.date))Object.assign(index.get(v.date),v);
   else state.dailyLotto.push({id:'lotto-'+v.date,...v,sourceSheet:'사이트 일별 입력',sourceRow:null});
 }
 if(!save()){state.dailyLotto=JSON.parse(before);return}
 render();toast('토토 일별 기록 '+updates.length+'일치를 저장했습니다. 월 확정 수입은 별도입니다.');
}
function confirmLotto(){
 const month=lottoMonth,daily=monthlyLottoDays(month),days=new Date(Number(month.slice(0,4)),Number(month.slice(5)),0).getDate();
 if(daily.length!==days){toast('모든 날짜를 입력해야 확정할 수 있습니다.');return}
 if(findSales(month,'lotto').length>1){toast('같은 월 수수료 중복 기록을 확인하세요.');return}
 const total=daily.reduce((a,x)=>a+x.commission,0),prev=salesValue(month,'lotto');
 if(!confirm(month+' 일별 수수료 합계 '+won(total)+'을 '+(prev.count?'기존 월 확정액 대신 저장':'월 확정 수입으로 등록')+'할까요?'+
   (prev.count&&prev.amount!==total?'\n이전 월 확정액: '+won(prev.amount):'')))return;
 const before=JSON.stringify(state.records);
 try{
   upsertSale(month,'lotto',total,prev.record?.note||'일별 수수료 합계로 확정');
   if(!save()){state.records=JSON.parse(before);return}
   render();toast(month+' 토토 월 수수료 확정: '+won(total));
 }catch(err){state.records=JSON.parse(before);toast(err.message)}
}
function classificationHistoryCards(entries){
 if(!entries.length)return '<p class="history-empty">아직 표시할 분류 변경이 없습니다.</p>';
 const names={scope:'사용처',ledgerType:'지출 종류',category:'대분류',subcategory:'소분류',status:'상태'};
 const value=(key,val)=>key==='scope'?(LABEL[val]||val||'없음'):key==='ledgerType'?(GROUP[val]||val||'없음'):key==='status'?({confirmed:'분류 완료',review:'미분류',excluded:'제외'}[val]||val||'없음'):(val||'없음');
 return '<div class="classification-history">'+entries.map(entry=>{
  const able=canUndoClassification(entry),stamp=new Date(entry.at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'});
  return '<article class="history-entry"><div class="history-entry-head"><div><b>'+E(entry.date)+' · '+E(entry.merchant)+'</b><span>'+E(won(entry.amount))+'</span></div><button class="btn'+(able?' primary':' subtle')+'" data-undo-classification="'+E(entry.id)+'"'+(able?'':' disabled')+'>'+(entry.undoneAt?'되돌림 완료':able?'이 변경 되돌리기':'현재 값이 달라짐')+'</button></div>'+
   '<dl class="history-diff">'+entry.fields.filter(key=>CLASS_FIELDS.includes(key)).map(key=>'<div><dt>'+E(names[key])+'</dt><dd><span>'+E(value(key,entry.before[key]))+'</span><span aria-label="변경 후">→</span><strong>'+E(value(key,entry.after[key]))+'</strong></dd></div>').join('')+'</dl>'+
   '<p class="history-time">'+E(entry.source==='local'?'변경 시간':entry.source)+' · '+E(stamp)+'</p></article>';
 }).join('')+'</div>';
}
function changesPage(){
 const recorded=state.classificationHistory||[];
 return pageIntro('RECENT CHANGES','최근 변경 · 되돌리기','어떤 거래를 잘못 눌렀는지 몰라도 변경 전·후 분류를 확인하고 해당 거래만 되돌릴 수 있습니다.')+
 '<section class="surface settings-box"><div class="surface-head"><div><h2>최근 분류 변경</h2><p>최근 100건을 보관합니다. 되돌린 내용도 변경 이력에 남습니다.</p></div></div>'+classificationHistoryCards(recorded)+
 (!recorded.length?'<p class="server-help">기능 추가 전에 바뀐 거래는 아래의 서버 저장 이력에서 찾아보세요.</p>':'')+'</section>'+
 '<section class="surface settings-box history-server"><div class="surface-head"><div><h2>이전 서버 저장본 비교</h2><p>남아 있는 최근 저장본 10개를 최신순으로 비교합니다. 장부 전체를 교체하지 않습니다.</p></div><button class="btn" id="load-classification-history"'+(historyBusy?' disabled':'')+'>'+(historyBusy?'비교 중…':serverHistory.length?'최신 저장 이력 새로고침':'서버 저장 이력 불러오기')+'</button></div>'+
 (historyMessage?'<p class="notice compact" role="status">'+E(historyMessage)+'</p>':'')+classificationHistoryCards(serverHistoryEntries)+
 (serverHistory.length>historyCursor?'<button class="btn" id="older-classification-history"'+(historyBusy?' disabled':'')+'>더 이전 변경 불러오기</button>':'')+'</section>';
}
async function loadClassificationHistory(older=false){
 if(historyBusy)return;
 if(!sync?.token){toast('서버 저장 이력은 저장 · 백업에서 로그인한 뒤 확인할 수 있습니다.');navigate('settings');return}
 historyBusy=true;historyMessage='서버 저장본을 읽어 분류 변경을 비교하고 있습니다.';render();
 try{
  if(!older){
   const versions=await sync.listHistory();
   serverHistory=versions;serverHistoryEntries=[];historyCursor=0;historyOlder=null;
   if(!versions.length){historyMessage='서버에 비교할 저장본이 없습니다.';return}
   const saved=await Promise.all(versions.slice(0,2).map(x=>sync.readVersion(x.version)));
   const latest=saved[0];historyOlder=saved.at(-1);historyCursor=saved.length;
   serverHistoryEntries.push(...classificationChanges(latest.data,state,{prefix:'local-v'+latest.version,source:'현재 기기와 서버 최신 버전 '+latest.version+' 비교'}));
   if(saved.length===2)serverHistoryEntries.push(...classificationChanges(saved[1].data,latest.data,{prefix:'server-v'+latest.version,at:latest.updatedAt,source:'서버 버전 '+saved[1].version+' → '+latest.version}));
  }else if(serverHistory[historyCursor]&&historyOlder){
   const previous=await sync.readVersion(serverHistory[historyCursor].version),latest=historyOlder;
   serverHistoryEntries.push(...classificationChanges(previous.data,latest.data,{prefix:'server-v'+latest.version,at:latest.updatedAt,source:'서버 버전 '+previous.version+' → '+latest.version}));
   historyOlder=previous;historyCursor++;
  }
  historyMessage=serverHistoryEntries.length?'분류가 바뀐 거래 '+serverHistoryEntries.length+'건을 찾았습니다. 변경 전·후를 확인한 뒤 해당 건만 되돌리세요.':'지금까지 비교한 저장본에는 분류 변경이 없습니다.';
 }catch(error){historyMessage=error.status===404?'서버 저장 이력을 아직 불러올 수 없습니다. 잠시 후 다시 시도하세요.':error.message;if(error.status===401)sync.error(error)}
 finally{historyBusy=false;render()}
}
function settingsPage(){
 return pageIntro('DATA & STORAGE','저장 · 백업','저장 상태를 확인하고 전체 장부를 백업할 수 있습니다.')+
 serverSettings()+mcpSettings()+
 '<section class="settings-grid"><div class="surface settings-box"><div class="surface-head"><div><h2>데이터 백업</h2><p>금융 정보와 거래처가 포함된 개인 파일입니다.</p></div></div>'+
 '<button class="btn primary wide" id="export-json">JSON 전체 백업 내려받기</button><button class="btn subtle wide" id="export-csv">CSV 거래내역 내려받기</button>'+
 '<div class="notice compact"><b>보안</b><p>백업 파일은 개인 기기 또는 암호화된 저장소에 보관하세요. 공개 GitHub에 업로드하면 안 됩니다.</p></div></div>'+
 '<div class="surface settings-box"><div class="surface-head"><div><h2>장부 현황</h2><p>이 기기에서 현재 열람 중인 자료입니다.</p></div></div>'+
 '<div class="summary-line"><span>거래내역</span><strong>'+state.records.length.toLocaleString('ko-KR')+'건</strong></div><div class="summary-line"><span>토토 일별 기록</span><strong>'+state.dailyLotto.length+'일</strong></div><div class="summary-line"><span>환불 내역</span><strong>'+state.refunds.length+'건</strong></div><div class="summary-line"><span>금융 파일 가져오기</span><strong>'+state.imports.length+'회</strong></div></div></section>'+
 '<details class="surface reset-data"><summary class="reset-summary">전체 데이터 초기화 <span>주의가 필요한 작업</span></summary><div class="surface-head"><div><h2>현재 장부 초기화</h2><p>서버 연결 중에는 서버에도 반영됩니다. 실행 전에 전체 백업을 보관하세요.</p></div></div>'+
 '<div class="reset-body"><div class="reset-counts"><span>거래 <b>'+state.records.length.toLocaleString('ko-KR')+'건</b></span>'+
 '<span>토토 일별 <b>'+(state.dailyLotto||[]).length.toLocaleString('ko-KR')+'건</b></span>'+
 '<span>편의점 순이익 <b>'+Object.keys(state.storeProfits||{}).length.toLocaleString('ko-KR')+'개월</b></span>'+
 '<span>가져오기 <b>'+state.imports.length.toLocaleString('ko-KR')+'회</b></span></div>'+
 '<p>거래·월매출·토토 일별 기록·온누리 결제 체크·직접 분류 규칙·가져오기 이력을 모두 초기화합니다. 중요한 자료는 JSON으로 먼저 백업하세요.</p>'+
 '<button type="button" class="btn danger" id="reset-all-v2">전체 데이터 초기화</button></div></details>'+
 '<div class="notice"><b>저장 상태 확인</b><p>상단에 “서버 저장 확인됨”이 표시된 자료만 서버 저장이 완료된 상태입니다. 연결이 끊겨도 이 기기의 자료는 유지되며, 다른 기기와 충돌하면 자료 선택 전까지 자동 덮어쓰기를 멈춥니다.</p></div>';
}
function mcpSettings(){
 let base='';try{const u=new URL(sync?.url||'');if(u.protocol==='https:')base=u.origin}catch{}
 const enabled=!!sync?.token,disabled=mcpConnectionBusy||!enabled?' disabled':'';
 return '<section class="surface settings-box"><div class="surface-head"><div><h2>AI 관리 연결</h2><p>사이트는 AI 연결 없이도 사용할 수 있습니다. 연결한 앱의 조회·수정 권한을 확인하거나 종료할 수 있습니다.</p></div></div>'+
 '<label class="field">MCP 서버 주소<input type="text" readonly value="'+E(base?base+'/mcp':'먼저 서버를 연결하세요.')+'" aria-label="MCP 서버 주소"></label>'+
 '<div class="server-actions">'+(base?'<a class="btn" href="'+E(base)+'/manage" target="_blank" rel="noopener noreferrer">연결 안내</a>':'')+'<button class="btn" id="mcp-load-connections"'+disabled+'>'+(mcpConnectionBusy?'확인 중…':'연결한 앱 확인')+'</button></div>'+
 (mcpConnectionMessage?'<p role="status">'+E(mcpConnectionMessage)+'</p>':'')+
 (enabled&&mcpConnections?mcpConnections.length?mcpConnections.map(x=>'<div class="summary-line"><div><b>'+E(x.name)+'</b><p class="server-help">'+E(x.scopes.includes('gagebu:write')?'조회·수정':'조회 전용')+' · '+(x.revoked?'권한 종료됨':'연결 만료 '+E(new Date(x.connectionExpiresAt*1000).toLocaleDateString('ko-KR',{timeZone:'Asia/Seoul'})))+'</p></div><button class="btn subtle" data-mcp-revoke="'+E(x.id)+'"'+(x.revoked||mcpConnectionBusy?' disabled':'')+'>연결 권한 종료</button></div>').join(''):'<p class="server-help">연결 중인 관리 앱이 없습니다.</p>':'')+'</section>';
}
async function mcpConnectionAction(id=''){
 if(!sync?.token||mcpConnectionBusy)return;
 if(id&&!confirm('이 앱의 가계부 조회·수정 권한을 종료할까요? 사이트의 일반 기능과 장부 자료는 유지됩니다.'))return;
 mcpConnectionBusy=true;mcpConnectionMessage='';render();
 try{if(id)await sync.request('/api/mcp/connections/revoke',{method:'POST',body:{id}});mcpConnections=(await sync.request('/api/mcp/connections')).connections;mcpConnectionMessage=id?'앱의 연결 권한을 종료했습니다.':''}
 catch(error){mcpConnectionMessage=error.message;if(error.status===401)sync.error(error)}
 finally{mcpConnectionBusy=false;render()}
}
function serverSettings(){
 const s=sync,status=storageFailure||s?.status.label||'이 브라우저에 저장됨',busy=serverBusy?' disabled':'',connected=!!s?.token;
 const last=s?.meta.lastSyncedAt?new Date(s.meta.lastSyncedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'아직 없음';
 return '<section class="surface server-storage"><div class="surface-head"><div><h2>서버 저장 · 기기 간 동기화</h2><p>로그인 후 변경 내용을 자동 저장합니다. 비밀번호는 저장하지 않습니다.</p></div><span class="tag '+(s?.status.kind==='saved'?'tag-ok':'tag-warn')+'">'+E(status)+'</span></div>'+
 '<div class="server-storage-body">'+(corruptStorage?'<div class="notice storage-alert"><b>저장된 원본을 읽지 못했습니다.</b><p>자동 저장을 중지하고 원본을 보존했습니다. 아래에서 원본을 내려받은 뒤 서버 자료를 불러올 수 있습니다.</p><button class="btn" id="backup-unreadable">읽지 못한 원본 내려받기</button></div>':'')+
 '<form id="server-login-form" class="server-connect"><label>개인 API 주소<input name="apiBase" type="url" required value="'+E(s?.url||'')+'" placeholder="https://store-ledger-private-api.계정.workers.dev" autocomplete="url"></label>'+
 '<label>관리자 비밀번호<input name="password" type="password" required autocomplete="current-password" placeholder="서버에 설정한 비밀번호"></label><button class="btn primary" type="submit"'+busy+'>'+(serverBusy?'연결 중…':connected?'다시 로그인':'서버 연결')+'</button></form>'+
 '<div class="server-meta"><span>마지막 서버 저장 <b>'+E(last)+'</b></span><span>서버 버전 <b>'+E(s?.meta.version??'—')+'</b></span></div>'+
 '<div class="server-actions"><button class="btn" id="server-retry"'+(!connected||serverBusy?' disabled':'')+'>연결 다시 확인</button><button class="btn" id="server-pull"'+(!connected||serverBusy?' disabled':'')+'>서버 자료 불러오기</button><button class="btn" id="server-push"'+(!connected||serverBusy?' disabled':'')+'>현재 장부를 서버에 저장</button><button class="btn subtle" id="server-logout"'+(!connected||serverBusy?' disabled':'')+'>로그아웃</button></div>'+
 (s?.stopped?'<div class="notice storage-alert"><b>자료가 서로 달라 자동 저장을 멈췄습니다.</b><p>서버 자료를 불러오거나 현재 장부로 서버를 갱신할 수 있습니다. 바뀌는 쪽의 자료는 JSON으로 먼저 백업합니다.</p></div>':'')+
 '<p class="server-help">연결 전에는 이 브라우저에만 보관됩니다. 로그인은 이 탭에서 12시간 유지되며, 금융 엑셀 원본 파일은 서버에 전송하지 않습니다.</p></div></section>';
}
async function serverAction(action,form){
 if(!sync||serverBusy)return;
 serverBusy=true;
 try{
  if(action==='login'){
   const values=new FormData(form);form.elements.password.value='';
   await sync.login(String(values.get('apiBase')||''),String(values.get('password')||''));
  }else if(action==='pull')await sync.pull();
  else if(action==='push')await sync.push();
  else if(action==='logout')await sync.logout();
  else await sync.start();
 }catch(error){sync.error(error);toast(error.message)}
 finally{serverBusy=false;render()}
}
function render(){
 const mainPage=page==='lotto'?'sales':page==='review'?'import':page==='rules'?'categories':page;
 $('#page-title').textContent=VIEWS[page]||'가계부';$$('[data-nav]').forEach(el=>el.classList.toggle('active',el.dataset.nav===mainPage));
 const navCount=$('#review-count');if(navCount){const ct=state.records.filter(x=>x.direction==='expense'&&reviewableExpense(x)).length+(state.refunds||[]).filter(x=>x.status==='review').length;navCount.textContent=ct?ct.toLocaleString('ko-KR'):'';navCount.hidden=!ct}
 const container=$('#content');
 container.innerHTML=({dashboard,review:reviewPage,records:recordsPage,sheet:sheetPage,categories:categoriesPage,sales:salesPage,lotto:lottoPage,import:importPage,rules:rulesPage,settings:settingsPage,changes:changesPage})[page]();
 const tabs=mainPage==='sales'?[['sales','월매출'],['lotto','토토 일별 매출']]:mainPage==='import'?[['import','파일 가져오기'],['review','미분류 검토']]:mainPage==='categories'?[['categories','분류 · 결제수단'],['rules','자동 분류 기준']]:null;
 if(tabs){const head=$('.page-head',container);head?.insertAdjacentHTML('afterend','<nav class="workspace-tabs" aria-label="'+E(VIEWS[page])+' 세부 메뉴">'+tabs.map(([route,label])=>'<button data-nav="'+route+'" class="'+(route===page?'selected':'')+'" aria-current="'+(route===page?'page':'false')+'">'+label+'</button>').join('')+'</nav>')}

 $('#sidebar').classList.remove('open');
 $('#mobile-menu').setAttribute('aria-expanded','false');
 refreshSaveStatus();
}
function navigate(p){
 if(!VIEWS[p])return;
 clearTimeout(queryTimer);
 if(page==='sheet'){readSheetCells();saveSheetDraft()}
 if(p==='lotto'&&page==='sales')lottoMonth=salesMonth;
 if(p==='sales'&&page==='lotto')salesMonth=lottoMonth;
 page=p;offset=0;reviewOffset=0;scopeFilter='all';typeFilter='all';paymentFilter='all';q='';
 location.hash='#'+p;render();window.scrollTo(0,0);
}
function patchRecord(id,updates){
 const row=state.records.find(x=>x.id===id);if(!row)return;
 Object.assign(row,updates);
 normalizeWindmoon(row);
 if(row.scope==='excluded')row.status='excluded';
 else if(row.scope!=='review')row.status='confirmed';
 if(!save()){render();return false}render();return true;
}
function chooseScope(id,scope){
 const row=state.records.find(x=>x.id===id);if(!row)return;
 const classification=G.classifyChoice(scope,row);
 const corrected={...classification};
 delete corrected.action;delete corrected.confidence;
 Object.assign(corrected,canonicalCategory(corrected.ledgerType,corrected.category,corrected.subcategory));
 if(patchRecord(id,corrected))toast(scope==='exclude'?'거래를 지출 합계에서 제외했습니다.':LABEL[scope]+'으로 분류했습니다.');
}
function fingerprint(row,occurrence){
 return [row.date,row.time,row.type,row.major,row.minor,row.merchant,Number(row.amount),row.payment,occurrence].join('¦');
}
function bankKey(raw){
 let h1=2166136261,h2=334214467;
 for(let i=0;i<raw.length;i++){const c=raw.charCodeAt(i);h1=Math.imul(h1^c,16777619);h2=Math.imul(h2^c,2246822519)}
 return (h1>>>0).toString(36)+'-'+(h2>>>0).toString(36);
}
function matchOld(row,candidates,used){
 const eligible=candidates.filter(x=>!used.has(x.id)&&!x.bankKey&&x.amount===money(row.amount)&&dateDiff(x.date,row.date)<=1&&!(x.category==='발주'&&x.subcategory==='주류')&&
   !(x.payment==='현금/송금'&&/(?:카드|POINT|CLASSIC|와우)/i.test(row.payment||'')));
 const exact=eligible.filter(x=>x.date===row.date);
 let pool=exact.length?exact:eligible;
 if(pool.length===1)return {record:pool[0],confidence:exact.length?1:0.6};
 if(pool.length>1){
   const p=G.normalizeMerchant(row.payment||'');
   const similar=pool.filter(x=>{
     const a=G.normalizeMerchant(x.payment||'');
     return a&&p&&(a.includes(p)||p.includes(a)||a.includes('신용카드')&&row.type==='지출');
   });
   if(similar.length===1)return {record:similar[0],confidence:0.82};
   return {ambiguous:true,record:null};
 }
 return {record:null};
}
const validateBankRange=range=>{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(range.from)||!/^\d{4}-\d{2}-\d{2}$/.test(range.to)||range.from>range.to||Number.isNaN(Date.parse(range.from+'T00:00:00Z'))||Number.isNaN(Date.parse(range.to+'T00:00:00Z')))
 throw Error('시작일은 종료일보다 늦을 수 없습니다.');
 return {...range};
};
/* Detect the recurring two-charge U+ pattern from the user's private ledger.
   Both internet and mobile use the same public merchant name; requiring several
   paired months prevents a new plan charge being assigned by amount alone. */
function classifyPairedLGUPlus(row){
 if(row.type!=='지출'||Number(row.amount)>=0||!/(?:LG\s*U\+|LGU\+|LG유플러스|엘지유플러스)/i.test(String(row.merchant||'')))return null;
 const key=G.normalizeMerchant(row.merchant),charges={business:[],personal:[]};
 for(const x of state.records){
   if(x.direction!=='expense'||x.status!=='confirmed'||G.normalizeMerchant(x.merchant||'')!==key)continue;
   if(x.ledgerType!=='fixed')continue;
   if(x.scope==='business'&&x.category==='가게'&&x.subcategory==='인터넷')charges.business.push(x);
   if(x.scope==='personal'&&x.category==='집'&&x.subcategory==='통신료')charges.personal.push(x);
 }
 const months={business:new Set(charges.business.map(x=>x.date.slice(0,7))),personal:new Set(charges.personal.map(x=>x.date.slice(0,7)))};
 const paired=[...months.business].filter(month=>months.personal.has(month));
 if(paired.length<3||months.business.size<3||months.personal.size<3)return null;
 const median=values=>{
   const a=values.slice().sort((x,y)=>x-y),mid=Math.floor(a.length/2);
   return a.length%2?a[mid]:(a[mid-1]+a[mid])/2;
 };
 const business=median(charges.business.map(x=>Number(x.amount))),personal=median(charges.personal.map(x=>Number(x.amount)));
 if(!(business>0&&personal>0))return null;
 // Rates need to be distinct; never infer when two plans overlap.
 if(Math.abs(business-personal)/Math.min(business,personal)<0.2)return null;
 const amount=money(row.amount);
 const distance={business:Math.abs(amount-business)/business,personal:Math.abs(amount-personal)/personal};
 const candidates=Object.keys(distance).filter(scope=>distance[scope]<=0.14);
 if(candidates.length!==1)return null;
 const scope=candidates[0],shop=scope==='business';
 return {action:'keep',scope,status:'confirmed',ledgerType:'fixed',
   category:shop?'가게':'집',subcategory:shop?'인터넷':'통신료',
   reason:'과거 확정 원장의 월별 LG U+ 이중 청구 패턴 ('+paired.length+'개월) 및 요금대 일치',
   confidence:0.95};
}
/* Credit amounts in BankSalad's '지출' rows are refunds. Only a uniquely
   identified earlier charge may be netted off, preserving FX differences. */
function findRefundTarget(refund,candidates,allocated=new Map()){
 const pay=paymentLabelKey(refund.payment),merchant=G.normalizeMerchant(refund.merchant||'');
 if(!pay||!merchant)return null;
 const plausible=candidates.filter(x=>{
   if(x.direction!=='expense'||x.status==='excluded'||!x.id)return false;
   if(paymentLabelKey(x.bankPayment||x.payment)!==pay)return false;
   if(G.normalizeMerchant(x.merchant||'')!==merchant)return false;
   const days=(Date.parse(refund.date+'T00:00:00Z')-Date.parse(x.date+'T00:00:00Z'))/86400000;
   if(!Number.isFinite(days)||days<0||days>120)return false;
   const paid=n(x.amount),credit=n(refund.amount);
   if(paid<=0||credit<=0||credit>paid*1.05+500-(allocated.get(x.id)||0))return false;
   return Math.abs(paid-credit)<=Math.max(400,paid*0.035);
 }).map(x=>{
   const paid=n(x.amount),credit=n(refund.amount);
   const days=(Date.parse(refund.date+'T00:00:00Z')-Date.parse(x.date+'T00:00:00Z'))/86400000;
   return {record:x,diff:Math.abs(paid-credit),days,score:Math.abs(paid-credit)/paid+days/5000};
 }).sort((a,b)=>a.score-b.score);
 if(!plausible.length)return null;
 const best=plausible[0],second=plausible[1];
 if(second&&Math.abs(second.diff-best.diff)<Math.max(500,n(best.record.amount)*0.007)&&Math.abs(second.days-best.days)<=2)return null;
 return best.record.id;
}
function reconcileBankRefunds(positives,newItems,links){
 const candidates=[...state.records.filter(x=>x.direction==='expense'),...newItems];
 const byId=new Map(state.records.map(x=>[x.id,x]));
 for(const l of links){const source=byId.get(l.id);
   if(source)candidates.push({...source,merchant:l.merchant||source.merchant,payment:l.payment,bankPayment:l.payment});
 }
 const allocated=new Map();
 for(const x of state.refunds||[])if(x.status==='matched'&&x.refundOf)
   allocated.set(x.refundOf,(allocated.get(x.refundOf)||0)+n(x.amount));
 const refs=[],already=new Set((state.refunds||[]).map(x=>x.bankKey));
 for(const {row,key} of positives){
   if(already.has(key))continue;
   const raw={id:'refund-'+key,bankKey:key,date:row.date,time:row.time,amount:Math.round(Number(row.amount)),
     payment:String(row.payment||''),merchant:String(row.merchant||''),source:'bank',bankType:row.type,
     sourceSheet:'뱅크샐러드',note:String(row.memo||''),refundOf:'',status:'review'};
   const linked=findRefundTarget(raw,candidates,allocated);
   if(linked){raw.refundOf=linked;raw.status='matched';
     allocated.set(linked,(allocated.get(linked)||0)+raw.amount)}
   refs.push(raw);already.add(key);
 }
 return refs;
}
async function processBank(file,range=bankImportRange){
 const bounds=validateBankRange(range);
 const parsed=await window.BankSaladXLSX.parseBankSalad(file);
 // Re-imports must recognize previously linked split charges and explicitly
 // excluded bank rows; otherwise duplicate expenses and payroll reappear.
 const existing=new Set([
   ...state.records.flatMap(x=>[
     x.bankKey,...(Array.isArray(x.extraBankKeys)?x.extraBankKeys:[])
   ]),
   ...(Array.isArray(state.excludedAudit)?state.excludedAudit.map(x=>x.bankKey):[])
 ].filter(Boolean));
 const source=state.records.filter(x=>x.source!=='bank'&&x.direction==='expense');
 const used=new Set(),counts={},all=[],links=[],refundRows=[];
 const duplicates=new Map();let reviewCount=0,outOfRange=0;
 const count=r=>{counts[r]=(counts[r]||0)+1};
 for(const row of parsed.rows){
   const root=fingerprint(row,0),i=duplicates.get(root)||0;duplicates.set(root,i+1);
   const key=bankKey(fingerprint(row,i));
   if(row.date<bounds.from||row.date>bounds.to){outOfRange++;continue}
   if(existing.has(key)){count('이미 가져온 거래');continue}
   if(row.type==='지출'&&Number(row.amount)>0){
     if(!(state.refunds||[]).some(x=>x.bankKey===key))refundRows.push({row,key});
     else count('이미 가져온 환불');
     continue;
   }
   let cls=G.classify(row,state.customRules);
   if(cls.action==='keep'&&cls.status==='review'&&/LG U\+ 가게 인터넷·개인 휴대폰/.test(cls.reason||'')){
     const paired=classifyPairedLGUPlus(row);
     if(paired)cls=paired;
   }
   const savedRent=state.rentRecipients?.[G.normalizeMerchant(row.merchant)];
   if(row.type==='이체'&&row.amount<0&&savedRent&&savedRent.amount===money(row.amount)){
     cls={action:'keep',scope:savedRent.scope,status:'confirmed',ledgerType:'fixed',
       category:savedRent.category,subcategory:savedRent.subcategory,reason:'이전 원장으로 확인된 월세·임대료 수취인'};
   }
   // Link rent transfers to verified source-sheet rent entries, without storing
   // any tenant/payee names or amounts as constants in the public code.
   if(cls.action==='skip'){
     if(row.type==='이체'&&row.amount<0){
       const rentSource=source.filter(x=>!used.has(x.id)&&!x.bankKey&&x.amount===money(row.amount)&&dateDiff(x.date,row.date)<=1&&
        ((x.category==='집'&&x.subcategory==='월세')||(x.category==='가게'&&x.subcategory==='임대료')));
       if(rentSource.length===1){
         const found=rentSource[0];used.add(found.id);
         links.push({id:found.id,bankKey:key,merchant:row.merchant,payment:row.payment,
          reason:'기존 원장과 월세/임대료 일치',proposedScope:found.scope,reviewConflict:false});
         continue;
       }
     }
     count(cls.reason);continue;
   }
   const match=matchOld(row,source,used);
   if(match.record&&match.confidence>=0.8){
     used.add(match.record.id);
     links.push({id:match.record.id,bankKey:key,merchant:row.merchant,payment:row.payment,
       reason:cls.reason,proposedScope:cls.scope,reviewConflict:cls.scope!=='review'&&match.record.scope!==cls.scope});
     continue;
   }
   const suggested=onnuriHistoryDefault(row.merchant,row.payment);
   const item={
     id:'bank-'+key,bankKey:key,source:'bank',sourceSheet:'뱅크샐러드',onnuri:suggested.checked,onnuriAuto:suggested.auto,
     direction:'expense',date:row.date,time:row.time,amount:money(row.amount),
     merchant:row.merchant||'거래처 미기재',payment:row.payment,note:row.memo||'',
     bankMajor:row.major,bankMinor:row.minor,
     scope:cls.scope,ledgerType:cls.ledgerType,category:cls.category,subcategory:cls.subcategory,
     status:cls.status,reason:match.ambiguous?'기존 원장과 날짜·금액 중복 후보 — 직접 확인':cls.reason,
     matchCandidate:!!match.ambiguous,manual:false
   };
   if(match.ambiguous){item.scope='review';item.status='review'}
   normalizeWindmoon(item);
   Object.assign(item,canonicalCategory(item.ledgerType,item.category,item.subcategory));
   if(item.status==='review')reviewCount++;
   all.push(item);
 }
 const refunds=reconcileBankRefunds(refundRows,all,links);
 return {fileName:parsed.fileName,total:parsed.rows.length,range:bounds,outOfRange,newItems:all,links,refunds,skips:counts,reviewCount};
}
async function onBankFile(file){
 if(!file)return;
 try{validateBankRange(bankImportRange);lastBankFile=file;
  const token=++bankLoadToken;
  $('#save-indicator').textContent='금융내역 분석 중…';
  const result=await processBank(file,{...bankImportRange});
  if(token!==bankLoadToken)return;
  preview=result;render();
  toast('분석 완료: '+preview.newItems.length+'건 신규 후보, '+preview.reviewCount+'건 검토 필요');
 }catch(e){console.error(e);toast('엑셀 분석 오류: '+e.message);setStatus('가져오기 실패')}
}
function commitBank(){
 if(!preview)return;
 if(!confirm('신규 거래 '+preview.newItems.length+'건, 기존 시트 연결 '+preview.links.length+'건, 환불 '+(preview.refunds||[]).length+'건을 등록할까요?\n환불 중 '+(preview.refunds||[]).filter(x=>x.status==='matched').length+'건은 원결제와 연결해 순지출에서 차감합니다. 확실하지 않은 환불은 검토로 남깁니다.'))return;
 const map=new Map(state.records.map(x=>[x.id,x]));
 state.rentRecipients=state.rentRecipients||{};
 for(const link of preview.links){
   const x=map.get(link.id);if(!x)continue;
   x.bankKey=link.bankKey;
   if(/온누리/.test(String(x.payment||'')))x.onnuri=true;
   if(!x.merchant)x.merchant=link.merchant||'';
   if(!x.bankPayment)x.bankPayment=link.payment||'';
   if(link.reviewConflict){x.scope='review';x.status='review';x.reason='기존 시트 분류와 금융 거래의 지역 규칙이 달라 확인 필요'}
   if(((x.category==='집'&&x.subcategory==='월세')||(x.category==='가게'&&x.subcategory==='임대료'))&&link.merchant){
     state.rentRecipients[G.normalizeMerchant(link.merchant)]={amount:x.amount,scope:x.scope,category:x.category,subcategory:x.subcategory};
   }
 }
 state.records.push(...preview.newItems);
 state.refunds=[...(state.refunds||[]),...(preview.refunds||[])];
 state.imports.push({at:new Date().toISOString(),name:preview.fileName,rows:preview.total,range:preview.range,outOfRange:preview.outOfRange,added:preview.newItems.length,linked:preview.links.length,review:preview.reviewCount,refundAdded:(preview.refunds||[]).length,refundMatched:(preview.refunds||[]).filter(x=>x.status==='matched').length});
 const count=preview.newItems.length,refundCount=(preview.refunds||[]).length;preview=null;
 if(save()){render();navigate('review');toast('거래 '+count+'건 · 환불 '+refundCount+'건 가져왔습니다. 미분류와 환불 검토를 확인하세요.')}
}
/* Backup imports are strictly non-destructive. Even a year-old V2 snapshot may
   only add missing records/dates; it cannot replace or silently edit newer data. */
function planSafeLedgerMerge(current,incoming){
 if(!incoming||incoming.version!==2||!Array.isArray(incoming.records))throw Error('지원하지 않는 가계부 JSON 형식입니다.');
 if(!GagebuValidation.validV2({...blank(),...incoming}))throw Error('백업의 날짜·금액·분류 형식이 올바르지 않습니다. 기존 장부는 변경하지 않았습니다.');
 const currentRows=Array.isArray(current.records)?current.records:[];
 const ids=new Set(currentRows.map(x=>String(x.id||'')).filter(Boolean));
 const banks=new Set(currentRows.flatMap(x=>[x.bankKey,...(Array.isArray(x.extraBankKeys)?x.extraBankKeys:[])]).filter(Boolean));
 const sourceKey=x=>x.source==='legacy'&&x.sourceSheet&&x.sourceRow!=null?'legacy|'+x.sourceSheet+'|'+x.sourceRow:'';
 const sources=new Set(currentRows.map(sourceKey).filter(Boolean));
 const fingerprint=x=>{
   if(!x.merchant||!x.date||!Number.isSafeInteger(Number(x.amount)))return '';
   return [x.direction||'expense',x.date,x.time||'',Number(x.amount),
     G.normalizeMerchant(x.merchant),G.normalizeMerchant(x.payment||'')].join('¦');
 };
 const currentCounts=new Map();
 for(const x of currentRows){const k=fingerprint(x);if(k)currentCounts.set(k,(currentCounts.get(k)||0)+1)}
 const matchedCounts=new Map();
 const incomingIds=new Set(),incomingBank=new Set(),incomingSource=new Set();
 let duplicates=0,conflicts=0,invalid=0;
 const additions=[];
 const byId=new Map(currentRows.filter(x=>x.id!=null).map(x=>[String(x.id),x]));
 for(const raw of incoming.records){
   if(!raw||typeof raw!=='object'||!GagebuValidation.date(raw.date)
      ||!Number.isSafeInteger(Number(raw.amount))||Number(raw.amount)<0
      ||!['expense','income','transfer'].includes(raw.direction)){invalid++;continue}
   const x={...raw},id=String(x.id||''),b=String(x.bankKey||''),s=sourceKey(x);
   if(id&&(ids.has(id)||incomingIds.has(id))){
     if(ids.has(id)){
       const old=byId.get(id);
       if(old&&['date','amount','direction','scope','ledgerType','category','subcategory','onnuri','payment','note'].some(field=>
          String(old[field]??'')!==String(x[field]??'')))conflicts++;
     }
     duplicates++;continue;
   }
   if(b&&(banks.has(b)||incomingBank.has(b))||s&&(sources.has(s)||incomingSource.has(s))){
     duplicates++;continue;
   }
   const signature=fingerprint(x);
   const used=matchedCounts.get(signature)||0;
   if(signature&&used<(currentCounts.get(signature)||0)){
     matchedCounts.set(signature,used+1);duplicates++;continue;
   }
   if(signature&&additions.some(y=>fingerprint(y)===signature&&
      String(y.id||'')===id&&id)){duplicates++;continue}
   if(!id)x.id='import-'+uid();
   additions.push(x);
   incomingIds.add(String(x.id));
   if(b)incomingBank.add(b);
   if(s)incomingSource.add(s);
 }
 const presentDays=new Set((current.dailyLotto||[]).map(x=>x.date));
 const dailyAdd=[];
 for(const raw of Array.isArray(incoming.dailyLotto)?incoming.dailyLotto:[]){
   const normalized=normalizeDailyLotto(raw);
   if(normalized&&!presentDays.has(normalized.date)){
     dailyAdd.push(normalized);presentDays.add(normalized.date);
   }
 }
 const profitAdd={};
 for(const [month,value] of Object.entries(incoming.storeProfits||{})){
   if(isMonth(month)&&Number.isSafeInteger(Number(value))&&current.storeProfits?.[month]==null)
     profitAdd[month]=Number(value);
 }
 const isEmpty=!currentRows.length&&!(current.dailyLotto||[]).length
   &&!Object.keys(current.storeProfits||{}).length
   &&!Object.keys(current.customRules||{}).length
   &&!(current.imports||[]).length;
 const base=isEmpty?{...blank(),...incoming}:current;
 // Existing custom rules, merchant lists, taxonomies, and edits always win.
 // An old backup must not resurrect a rule, payee, or excluded bank entry
 // deliberately removed from an active ledger. Only a pristine restore copies them.
 const rules={...(base.customRules||{})},rent={...(base.rentRecipients||{})};
 const audit=Array.isArray(base.excludedAudit)?[...base.excludedAudit]:[];
 const existingRefunds=Array.isArray(current.refunds)?current.refunds:[];
 const refundKeys=new Set(existingRefunds.map(x=>x.bankKey||x.id));
 const recordKeys=new Set([...currentRows,...additions].filter(x=>x.direction==='expense').map(x=>x.id));
 const refundIds=new Set(existingRefunds.map(x=>x.id)),refundAdd=[];
 for(const raw of incoming.refunds||[]){
   const key=raw.bankKey||raw.id;
   if(refundKeys.has(key)||refundIds.has(raw.id))continue;
   const x={...raw};
   if(x.status==='matched'&&!recordKeys.has(x.refundOf))Object.assign(x,{status:'review',refundOf:'',reason:'같은 거래 병합 후 원결제 연결 확인 필요'});
   refundKeys.add(key);refundIds.add(x.id);refundAdd.push(x);
 }
 const next={...base,version:2,records:[...currentRows,...additions],refunds:[...existingRefunds,...refundAdd],
   dailyLotto:[...(current.dailyLotto||[]),...dailyAdd],
   storeProfits:{...(current.storeProfits||{}),...profitAdd},
   customRules:rules,rentRecipients:rent,excludedAudit:audit};
 const currentLast=currentRows.reduce((v,x)=>x.date>v?x.date:v,'');
 const incomingLast=incoming.records.reduce((v,x)=>x?.date>v?x.date:v,'');
 return {next,added:additions.length,refundsAdded:refundAdd.length,duplicates,conflicts,invalid,
   dailyAdded:dailyAdd.length,profitsAdded:Object.keys(profitAdd).length,
   oldFile:!!(currentLast&&incomingLast&&incomingLast<currentLast),
   currentLast,incomingLast};
}

/* Verified, narrowly scoped refund reconciliation file. Current records are
   matched by id/date/amount/payment/status before any update. */
function planRefundReconciliation(current,file){
 if(file?.format!=='gagebu-v2-refund-reconciliation'||file?.version!==1||
    !Array.isArray(file.refunds)||!Array.isArray(file.updates))throw Error('환불 수정 파일 형식 오류');
 const byId=new Map((current.records||[]).map(x=>[String(x.id),x]));
 const refundKeys=new Set((current.refunds||[]).map(x=>x.bankKey));
 const allocations=new Map();
 for(const x of current.refunds||[])if(x.status==='matched'&&x.refundOf)
   allocations.set(x.refundOf,(allocations.get(x.refundOf)||0)+n(x.amount));
 const refunds=[];let duplicates=0,missing=0,conflicts=0;
 for(const raw of file.refunds){
   if(!raw||!raw.bankKey||!raw.id||!Number.isSafeInteger(Number(raw.amount))||Number(raw.amount)<=0||
      !/^\d{4}-\d\d-\d\d$/.test(String(raw.date||''))||!raw.payment||!raw.merchant||
      !['matched','review'].includes(raw.status))throw Error('환불 항목 구성 오류');
   if(refundKeys.has(raw.bankKey)){duplicates++;continue}
   const row={id:String(raw.id),bankKey:String(raw.bankKey),date:String(raw.date),time:String(raw.time||''),
     amount:Number(raw.amount),merchant:String(raw.merchant),payment:String(raw.payment),
     note:String(raw.note||''),source:'bank',sourceSheet:'뱅크샐러드',bankType:'지출',
     status:raw.status,refundOf:String(raw.refundOf||'')};
   if(row.status==='matched'){
     const original=byId.get(row.refundOf);
     if(!original){missing++;continue}
     // Re-validate the original debit using the same conservative matcher.
     if(findRefundTarget(row,[original],allocations)!==row.refundOf){conflicts++;continue}
     allocations.set(row.refundOf,(allocations.get(row.refundOf)||0)+row.amount);
   }else if(row.refundOf){throw Error('미확인 환불에 원결제 식별자가 있습니다.')}
   refunds.push(row);refundKeys.add(row.bankKey);
 }
 const updated=[],seen=new Set(),fields=['status','scope','category','subcategory','manual','reason'];
 for(const entry of file.updates){
   if(!entry||!entry.id||seen.has(entry.id)||!entry.match||!entry.set||
      Object.keys(entry.set).some(k=>!fields.includes(k)))throw Error('기존 기록 수정 항목 구성 오류');
   seen.add(entry.id);
   const original=byId.get(entry.id);
   if(!original){missing++;continue}
   if(Object.entries(entry.set).every(([k,v])=>original[k]===v)){duplicates++;continue}
   if(!['date','amount','payment','status','scope'].every(k=>String(original[k]??'')===String(entry.match[k]??''))){
     conflicts++;continue;
   }
   if(!['confirmed','excluded'].includes(entry.set.status)||!['personal','excluded'].includes(entry.set.scope)||entry.set.manual!==true){
     throw Error('수정 상태가 허용 범위를 벗어났습니다.');
   }
   updated.push({id:entry.id,set:entry.set});
 }
 return {refunds,updated,duplicates,missing,conflicts};
}
function applyRefundReconciliation(file,filename){
 let plan;try{plan=planRefundReconciliation(state,file)}
 catch(e){toast('환불 수정 오류: '+e.message);return}
 const applied=plan.refunds.filter(x=>x.status==='matched');
 const pending=plan.refunds.filter(x=>x.status==='review');
 if(!plan.refunds.length&&!plan.updated.length){
   toast('새로 반영할 거래가 없습니다. 중복 '+plan.duplicates+'건 · 충돌 '+plan.conflicts+'건');return;
 }
 const description='카드 환불 '+plan.refunds.length+'건 (원결제 연결 '+applied.length+
   '건 · 확인 필요 '+pending.length+'건) / 기존 장부 중복 조정 '+plan.updated.length+'건'+
   (plan.missing||plan.conflicts?'\n누락 '+plan.missing+'건 · 기존 수정과 충돌 '+plan.conflicts+'건은 제외':'');
 if(!confirm('기존 가계부를 유지한 채 다음 항목을 반영합니다.\n\n'+description+
   '\n\n대응하는 원결제에 환불액을 차감하고, 원본 승인·환불 금액은 보존합니다.'+
   '\n수정 전 전체 JSON 자동 백업을 다운로드합니다. 진행할까요?'))return;
 try{download('가계부_V2_환불반영전_자동백업_'+new Date().toISOString().replace(/[:.]/g,'-')+'.json',
     JSON.stringify({...state,exportedAt:new Date().toISOString()},null,2),'application/json;charset=utf-8')}
 catch(e){toast('백업 파일 생성 실패: 수정하지 않았습니다.');return}
 const previous=state;
 const updates=new Map(plan.updated.map(x=>[x.id,x.set]));
 state={...state,records:state.records.map(x=>updates.has(x.id)?{...x,...updates.get(x.id)}:x),
   refunds:[...(state.refunds||[]),...plan.refunds],
   imports:[...(state.imports||[]),{at:new Date().toISOString(),name:filename,
     source:'verified-refund-reconciliation',refunds:plan.refunds.length,matched:applied.length,updated:plan.updated.length}]};
 if(!save()){state=previous;return}
 preview=null;render();toast('환불 '+plan.refunds.length+'건 / 거래 조정 '+plan.updated.length+'건 반영 완료');
}
function planOnnuriCorrections(current,patch){
 if(patch?.format!=='gagebu-v2-corrections'||patch?.version!==1||!Array.isArray(patch.corrections))throw Error('수정 패치 형식 오류');
 const byId=new Map((current.records||[]).map(r=>[String(r.id),r]));
 const changes=[],seen=new Set();let unchanged=0,missing=0,conflicts=0;
 for(const entry of patch.corrections){
   if(!entry||typeof entry.id!=='string'||seen.has(entry.id)||!entry.match||!entry.set||
      Object.keys(entry.set).some(k=>!['onnuriLinkedCard','onnuriCardSource','onnuri','onnuriManual','merchant','subcategory','merchantSource'].includes(k)))throw Error('수정 패치 구성 오류');
   seen.add(entry.id);
   const r=byId.get(entry.id);
   if(!r){missing++;continue}
   if(r.date!==entry.match.date||r.amount!==entry.match.amount||r.direction!=='expense'||
      r.payment!==entry.match.payment||r.onnuri===false){conflicts++;continue}
   if(entry.set.merchant!=='새종로약국'||entry.set.subcategory!=='약국'||entry.set.merchantSource!=='user-confirmed')
     throw Error('확인되지 않은 거래처 수정');
   if((r.merchant&&r.merchant!==entry.set.merchant)||!['병원/의원','약국'].includes(r.subcategory)){
     conflicts++;continue;
   }
   if(entry.set.onnuriLinkedCard!=='The CLASSIC-Y'||entry.set.onnuriCardSource!=='user-confirmed'||
      entry.set.onnuri!==true||entry.set.onnuriManual!==true)throw Error('확인되지 않은 카드 지정');
   if(r.onnuriLinkedCard&&r.onnuriLinkedCard!==entry.set.onnuriLinkedCard){conflicts++;continue}
   if(Object.entries(entry.set).every(([k,v])=>r[k]===v)){unchanged++;continue}
   changes.push({id:entry.id,date:r.date,amount:r.amount,set:entry.set});
 }
 return {changes,unchanged,missing,conflicts};
}
function applyOnnuriCorrections(patch,filename){
 let result;try{result=planOnnuriCorrections(state,patch)}catch(err){toast('수정 파일 오류: '+err.message);return}
 if(!result.changes.length){toast('수정할 거래 없음 · 이미 반영 '+result.unchanged+'건 / 미등록 '+result.missing+'건 / 내용 불일치 '+result.conflicts+'건');return}
 if(!confirm('확인된 온누리 연동 카드 '+result.changes.length+'건을 수정합니다.\n'+
   result.changes.map(x=>x.date+' · '+won(x.amount)).join('\n')+
   '\n\n금액·원본 결제수단·은행 원본 정보는 유지하고, 사용자 확인 거래처·약국 분류·연동 카드만 수정합니다.'+
   (result.missing||result.conflicts?'\n미등록 '+result.missing+'건 · 내용 불일치 '+result.conflicts+'건은 변경하지 않습니다.':'')+
   '\n\n수정 전 JSON을 자동 백업합니다. 계속할까요?'))return;
 try{download('가계부_V2_수정전_자동백업_'+new Date().toISOString().replace(/[:.]/g,'-')+'.json',
   JSON.stringify(state,null,2),'application/json;charset=utf-8')}
 catch(err){toast('백업 생성 실패. 자료를 변경하지 않았습니다.');return}
 const previous=state,mapping=new Map(result.changes.map(x=>[x.id,x.set]));
 state={...state,records:state.records.map(r=>mapping.has(String(r.id))?{...r,...mapping.get(String(r.id))}:r),
   imports:[...(state.imports||[]),{at:new Date().toISOString(),name:filename,source:'onnuri-user-confirmed-correction',updated:result.changes.length}]};
 if(!save()){state=previous;return}
 render();toast('온누리 연동카드 '+result.changes.length+'건 수정 완료');
}
async function importLegacy(file){
 if(!file)return;
 let raw,incoming;
 try{
   raw=JSON.parse(await file.text());
   if(raw?.format==='gagebu-v2-refund-reconciliation'){applyRefundReconciliation(raw,file.name);return}
   if(raw?.format==='gagebu-v2-corrections'){applyOnnuriCorrections(raw,file.name);return}
   incoming=raw?.version===2&&Array.isArray(raw.records)?raw:{
     version:2,records:migrateLegacy(raw),
     dailyLotto:Array.isArray(raw?.dailyLotto)?raw.dailyLotto:[],
     storeProfits:raw?.storeProfits&&typeof raw.storeProfits==='object'?raw.storeProfits:{}
   };
 }catch(err){toast('JSON 읽기 실패: '+err.message);return}
 let plan;
 try{plan=planSafeLedgerMerge(state,incoming)}
 catch(err){toast(err.message);return}
 const count=plan.added+plan.dailyAdded+plan.profitsAdded+plan.refundsAdded;
 if(!count){toast('이미 등록된 자료입니다. 기존 거래 '+plan.duplicates+'건을 유지하며 아무것도 변경하지 않았습니다.');return}
 const warning=plan.oldFile?'\n⚠ 이 파일의 최근 거래일('+plan.incomingLast+')이 현재 장부('+plan.currentLast+')보다 오래되었습니다. 기존 기록은 삭제되지 않습니다.':'';
 const message='안전 병합으로 등록합니다.\n\n새 거래 '+plan.added+'건 / 토토 일별 '+plan.dailyAdded+
   '일 / 월 순이익 '+plan.profitsAdded+'개월 / 환불 '+plan.refundsAdded+'건 추가\n중복 '+plan.duplicates+'건 건너뜀'+
   (plan.conflicts?'\n다르게 수정된 기존 거래 '+plan.conflicts+'건: 현재 값 유지':'')+
   (plan.invalid?'\n파일 내 형식 오류 '+plan.invalid+'건: 추가하지 않음':'')+
   warning+'\n\n현재 등록된 거래·수정 내용·온누리 체크는 덮어쓰거나 삭제하지 않습니다.'+
   '\n병합 전 자동 백업 파일도 다운로드합니다. 진행할까요?';
 if(!confirm(message))return;
 // User-owned recovery snapshot before the only write. No public/server upload.
 try{
   download('가계부_V2_병합전_자동백업_'+new Date().toISOString().replace(/[:.]/g,'-')+'.json',
     JSON.stringify({...state,exportedAt:new Date().toISOString()},null,2),'application/json;charset=utf-8');
 }catch(err){toast('자동 백업 파일 생성 실패: 데이터를 변경하지 않았습니다.');return}
 const previous=state;
 plan.next.imports=[...(plan.next.imports||[]),{at:new Date().toISOString(),
   name:file.name,source:'safe-merge',added:plan.added,duplicates:plan.duplicates,
   conflicts:plan.conflicts,dailyAdded:plan.dailyAdded,profitsAdded:plan.profitsAdded,refundsAdded:plan.refundsAdded}];
 state=plan.next;
 if(!save()){state=previous;return}
 preview=null;render();
 toast('안전 병합 완료: 거래 '+plan.added+'건 · 환불 '+plan.refundsAdded+'건 추가 · 기존 거래 '+plan.duplicates+'건 유지');
}
function download(name,contents,type){
 const url=URL.createObjectURL(new Blob([contents],{type}));
 const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
 setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function exportJSON(){download('가계부_V2_개인백업_'+now()+'.json',JSON.stringify({...state,exportedAt:new Date().toISOString()},null,2),'application/json;charset=utf-8')}
function transactionCSV(){
 const headers=['날짜','시간','거래처','실제 결제수단','뱅샐 등록 카드·원본 결제수단','온누리 사용','지출 반영액','원결제 금액(참고)','연결 환불(참고)','사용처','지출종류','대분류','소분류','상태','원본','메모','항목','원결제 ID','원결제 연결상태','거래금액'];
 const rows=ledgerEntries().sort((a,b)=>a.date.localeCompare(b.date)||String(a.time||'').localeCompare(String(b.time||''))).map(x=>{
  const refund=isRefundEntry(x);
  return [x.date,x.time,x.merchant,paymentLabel(x),x.bankPayment||x.payment||'',!refund&&isOnnuri(x)?'예':'아니오',
   countedExpense(x)?n(x.amount):0,refund?(x.originalAmount??''):x.amount,refund?0:refundedAmount(x),
   LABEL[x.scope]||(refund?'사용처 미지정':x.scope),refund?'환불':GROUP[x.ledgerType]||'',x.category,x.subcategory,x.status,x.sourceSheet||'',x.note,
   refund?'환불':'결제',refund?x.refundOf||'':x.id,refund?(x.refundStatus==='matched'?'연결됨':'미연결'):'',x.amount];
 });
 const enc=x=>'"'+String(x??'').replaceAll('"','""')+'"';
 return '\uFEFF'+[headers,...rows].map(r=>r.map(enc).join(',')).join('\r\n');
}
function exportCSV(){download('가계부_V2_거래내역_'+now()+'.csv',transactionCSV(),'text/csv;charset=utf-8')}
/* Explicit deletion operations. Never mutate V1 localStorage or source files.
   Storage is committed before UI acknowledges removal. */
function deleteRecordById(id,confirmAction=true){
 const row=state.records.find(x=>x.id===id);
 if(!row)return false;
 const isIncome=row.direction==='income';
 const label=(row.merchant||row.category||'거래')+' / '+row.date+' / '+won(row.amount);
 if(confirmAction&&!confirm(label+'\n\n이 기록을 완전히 삭제할까요? 미분류/제외 처리가 아닌 실제 삭제입니다.'))return false;
 const before=state;
 const records=state.records.filter(x=>x.id!==id);
 if(records.length===state.records.length)return false;
 const profits={...(state.storeProfits||{})};
 if(isIncome&&row.category==='가게 매출'&&!records.some(x=>x.direction==='income'&&x.category==='가게 매출'&&x.date.slice(0,7)===row.date.slice(0,7)))delete profits[row.date.slice(0,7)];
 const refunds=(state.refunds||[]).map(x=>x.refundOf===id?{...x,status:'review',refundOf:null,previousRefundOf:id,reason:'원결제 삭제 후 환불 연결 확인 필요'}:x);
 state={...state,records,storeProfits:profits,refunds};
 if(!save()){state=before;return false}
 preview=null;render();toast('기록 1건을 삭제했습니다.');
 return true;
}
function deleteDailyLotto(date,confirmAction=true){
 const original=state.dailyLotto||[];
 const record=original.find(x=>x.date===date);
 if(!record)return false;
 if(confirmAction&&!confirm(date+' 토토 일별 매출 및 수수료를 삭제할까요?\n이미 확정한 월 수수료는 그대로 유지됩니다.'))return false;
 const before=state;
 state={...state,dailyLotto:original.filter(x=>x.date!==date),legacyDailySynced:true};
 if(!save()){state=before;return false}
 render();toast(date+' 토토 일별 기록을 삭제했습니다.');
 return true;
}
function resetAllV2(confirmAction=true){
 if(confirmAction){
   const entry=prompt('전체 거래와 사용자 규칙을 초기화합니다. 서버 연결 중에는 서버에도 반영됩니다.\n진행하려면 정확히 "전체삭제"를 입력하세요.','');
   if(entry!=='전체삭제')return false;
   if(!confirm('최종 확인: 거래 '+state.records.length+'건, 토토 일별 '+(state.dailyLotto||[]).length+'건 및 설정을 모두 초기화할까요?\n초기화 전 자동 백업을 내려받습니다.'))return false;
 }
 if(confirmAction)exportJSON();
 const previous=state;
 state={...blank(),legacyDailySynced:true,bankSaladBaselineVersion:2,windmoonSubcategoryMigration:true,migratedFromV1:false};
 if(!save()){state=previous;return false}
 preview=null;lastBankFile=null;bankLoadToken++;
 taxonomy();
 editing=null;sheetData.rows=[];sheetData.date=now();period='all';scopeFilter='all';typeFilter='all';q='';offset=0;reviewOffset=0;salesMonth=ym();lottoMonth=ym();
 render();toast('장부를 초기화했습니다.');
 return true;
}

function updateEditorSuggestions(){
 const form=$('#editor-form');if(!form)return;
 const group=form.elements.ledgerType?.value||'consumption';
 const category=form.elements.category?.value||'';
 const majorList=$('#editor-major-options'),subList=$('#editor-minor-options'),payList=$('#editor-payment-options');
 if(majorList)majorList.innerHTML=valueOptions([...new Set([...Object.keys(categoriesFor(group)),category].filter(Boolean))]);
 if(subList)subList.innerHTML=valueOptions([...new Set([...(categoriesFor(group)[category]||[]),form.elements.subcategory?.value||''].filter(Boolean))]);
 if(payList)payList.innerHTML=valueOptions(paymentChoices());
}
function editRecord(id){
 const r=id?state.records.find(x=>x.id===id):null;
 editing=id||'new';
 const dlg=$('#editor');
 $('#editor-title').textContent=r?(r.status==='excluded'?'제외된 거래 수정':'거래 수정'):'거래 직접 입력';
 $('#editor-save').textContent=r?.status==='excluded'?'수정 후 복원':'거래 저장';
 $('#editor-exclude-record').hidden=!r||r.status==='excluded';
 const del=$('#editor-delete-record');if(del){del.hidden=!r;del.dataset.deleteRecord=r?.id||''}
 const f=$('#editor-form');
 f.elements.date.value=r?.date||now();
 f.elements.amount.value=r?.amount??'';
 f.elements.merchant.value=r?.merchant||'';
 f.elements.payment.value=r?.payment||'';
 f.elements.onnuri.checked=r?isOnnuri(r):false;
 f.elements.onnuri.dataset.onnuriTouched='0';
 f.elements.onnuri.dataset.onnuriAuto=r?.onnuriAuto?'1':'0';
 const cardHint=$('#editor-registered-card');if(cardHint)cardHint.textContent=[r?.bankPayment?'뱅크샐러드 등록 카드: '+r.bankPayment:'',r?.onnuriLinkedCard?'온누리 연동 카드 (사용자 확인): '+r.onnuriLinkedCard:'',!r?.bankPayment&&!r?.onnuriLinkedCard&&r?.payment?'원본 결제수단: '+r.payment:''].filter(Boolean).join(' · ');
 f.elements.scope.innerHTML=sheetOptions(Object.entries(LABEL).filter(([id])=>!['transfer','excluded'].includes(id)),r?.scope||'personal');
 f.elements.ledgerType.innerHTML=sheetOptions(Object.entries(GROUP),r?.ledgerType||'consumption');
 f.elements.scope.value=r?.scope&&r.scope!=='excluded'?r.scope:'personal';
 f.elements.ledgerType.value=r?.ledgerType||'consumption';
 f.elements.category.value=r?.category||'';
 f.elements.subcategory.value=r?.subcategory||'';
 if(!r?.subcategory&&r?.scope==='windmoon')f.elements.subcategory.value='풍월관';
 f.elements.note.value=r?.note||'';
 updateEditorSuggestions();
 $('#editor-merchant-options').innerHTML=valueOptions([...new Set(state.records.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(x=>x.merchant).filter(Boolean))].slice(0,120));
 syncEditorOnnuriDefault();
 $('#editor-details').open=!!r;
 dlg.showModal();
 if(!r)f.elements.amount.focus();
}
function submitEditor(f){
 if(editing==='new')syncEditorOnnuriDefault();
 const data=new FormData(f);const amt=numInput(data.get('amount'));
 const merchant=String(data.get('merchant')||'').trim();
 if(!GagebuValidation.date(String(data.get('date')))||!GagebuValidation.amount(amt)||amt<=0||!merchant){toast('날짜·원 단위 정수 금액·거래처를 확인하세요.');return}
 const scope=String(data.get('scope')),ledgerType=String(data.get('ledgerType')),category=String(data.get('category')||'').trim();
 const previous=editing!=='new'?state.records.find(x=>x.id===editing):null;
 const touched=f.elements.onnuri.dataset.onnuriTouched==='1';
 if(editing==='new'&&!touched)syncEditorOnnuriDefault();
 const auto=editing==='new'?f.elements.onnuri.dataset.onnuriAuto==='1':!!previous?.onnuriAuto;
 const entry={date:String(data.get('date')),amount:amt,merchant,payment:String(data.get('payment')||''),
 onnuri:data.has('onnuri'),onnuriAuto:auto&&!touched,onnuriManual:touched||!!previous?.onnuriManual,note:String(data.get('note')||''),scope,ledgerType,category:category||'기타',subcategory:String(data.get('subcategory')||''),status:scope==='review'?'review':'confirmed',manual:true,direction:'expense'};
 normalizeWindmoon(entry);
 Object.assign(entry,canonicalCategory(entry.ledgerType,entry.category,entry.subcategory));
 try{if(!addInputCategories([entry],!!category))return}catch(error){toast(error.message);return}
 if(editing&&editing!=='new'){const row=state.records.find(x=>x.id===editing);if(row)Object.assign(row,entry)}
 else state.records.push({...entry,id:'manual-'+uid(),direction:'expense',source:'manual',sourceSheet:'직접 입력',time:'',bankKey:''});
 if(!save())return;
 $('#editor').close();render();toast('거래를 저장했습니다.');
}
function onClick(event){
 const target=event.target.closest('button,a,[data-nav]');if(!target)return;
 if(target.id==='mcp-load-connections'){void mcpConnectionAction();return}
 if(target.dataset.mcpRevoke){void mcpConnectionAction(target.dataset.mcpRevoke);return}
 if(target.dataset.undoClassification){
  const entry=[...(state.classificationHistory||[]),...serverHistoryEntries].find(x=>x.id===target.dataset.undoClassification);if(entry)undoClassification(entry);return;
 }
 if(target.id==='load-classification-history'){void loadClassificationHistory();return}
 if(target.id==='older-classification-history'){void loadClassificationHistory(true);return}
 if(target.dataset.nav){event.preventDefault();navigate(target.dataset.nav);return}
 if(['top-new-record','mobile-new-record','dashboard-new-record'].includes(target.id)){editRecord();return}
 if(['server-retry','server-pull','server-push','server-logout'].includes(target.id)){void serverAction(target.id.slice(7));return}
 if(target.id==='backup-unreadable'){try{download('가계부_읽기오류_원본_'+now()+'.json',localStorage.getItem(KEY)||'','application/json;charset=utf-8')}catch{toast('원본을 읽지 못했습니다. 브라우저 저장 권한을 확인하세요.')}return}
 if(target.dataset.scope){chooseScope(target.dataset.id,target.dataset.scope);return}
 if(target.dataset.edit){editRecord(target.dataset.edit);return}
 if(target.dataset.manageRefund){openRefund(target.dataset.manageRefund);return}
 if(target.dataset.refundTarget){changeRefund('link',target.dataset.refundTarget);return}
 if(target.dataset.refundAction){changeRefund(target.dataset.refundAction);return}
 if(['close-refund-editor','close-refund-secondary'].includes(target.id)){$('#refund-editor').close();return}
 if(target.dataset.recordMode){recordsMode=target.dataset.recordMode;offset=0;render();return}
 if(target.dataset.restoreRecord){restoreRecord(target.dataset.restoreRecord);return}
 if(target.id==='editor-exclude-record'){excludeRecord(editing);return}
 if(target.dataset.taxHide){
   const action=target.dataset.taxHide,group=target.dataset.taxGroup||'',major=target.dataset.taxMajor||'',minor=target.dataset.taxMinor||'';
   if(!confirm('이 분류를 신규 입력 목록에서 숨길까요? 과거 거래는 삭제되지 않습니다.'))return;
   const before=JSON.stringify(state);
   try{
     editTax(action,group,major,minor,'');
     if(!save()){state=JSON.parse(before);return}
     render();toast('분류를 입력 목록에서 숨겼습니다.');
   }catch(err){state=JSON.parse(before);toast(err.message)}
   return;
 }
 if(target.dataset.deleteRecord){const id=target.dataset.deleteRecord;if(deleteRecordById(id)&&$('#editor')?.open)$('#editor').close();return}
 if(target.dataset.deleteLotto){deleteDailyLotto(target.dataset.deleteLotto);return}
 if(target.id==='reset-all-v2'){resetAllV2();return}
 if(target.dataset.dashboardPay){
   dashboardPayMetric=target.dataset.dashboardPay==='count'?'count':'amount';
   render();return;
 }
 if(target.dataset.dashboardExpandPayments){dashboardPayAll=!dashboardPayAll;render();return}
 if(target.id==='clear-payment-filter'){paymentFilter='all';offset=0;render();return}
 if(target.id==='restore-bank-presets'){restoreBankSaladPresets();return}
 if(target.id==='sheet-add-5'||target.id==='sheet-add-20'){
   readSheetCells();const count=target.id==='sheet-add-5'?5:20;
   for(let i=0;i<count&&sheetData.rows.length<sheetData.limit;i++)sheetData.rows.push(sheetNewRow());render();return
 }
 if(target.id==='sheet-remove-empty'){
   readSheetCells();sheetData.rows=sheetData.rows.filter(x=>SHEET_FIELDS.some(f=>f==='onnuri'?!!x.onnuri:(!['date','scope','ledgerType'].includes(f)&&String(x[f]||'').trim())));
   while(sheetData.rows.length<5)sheetData.rows.push(sheetNewRow());render();return
 }
 if(target.id==='sheet-submit'){submitSheet();return}
 if(target.dataset.sheetDelete!==undefined){readSheetCells();sheetData.rows.splice(Number(target.dataset.sheetDelete),1);if(!sheetData.rows.length)sheetData.rows.push(sheetNewRow());render();return}
 if(target.dataset.salesSelect){salesMonth=target.dataset.salesSelect;lottoMonth=salesMonth;render();return}
 if(target.id==='confirm-lotto'){confirmLotto();return}
 if(target.id==='new-record'){editRecord();return}
 if(target.id==='commit-bank'){commitBank();return}
 if(target.id==='discard-import'){preview=null;render();return}
 if(target.id==='export-json'){exportJSON();return}
 if(target.id==='export-csv'){exportCSV();return}
 if(target.id==='mobile-menu'){const open=$('#sidebar').classList.toggle('open');target.setAttribute('aria-expanded',String(open));return}
 if(target.id==='close-sidebar'){ $('#sidebar').classList.remove('open');return}
 if(['close-editor','close-editor-secondary'].includes(target.id)){$('#editor').close();return}
 if(target.dataset.pageStep){
   offset=Math.max(0,offset+Number(target.dataset.pageStep)*80);render();return;
 }
 if(target.dataset.reviewPage){
   reviewOffset=Math.max(0,reviewOffset+(target.dataset.reviewPage==='next'?35:-35));render();return;
 }
 if(target.dataset.removeRule){
   if(confirm('거래처에 저장된 자동 분류 규칙을 제거할까요?')){
     delete state.customRules[target.dataset.removeRule];save();render();
   }
 }
}
function onChange(e){
 const el=e.target;
 if(el.id==='edit-onnuri'){el.dataset.onnuriTouched='1';el.dataset.onnuriAuto='0';return}
 if(el.dataset.onnuriId){
   const x=state.records.find(r=>r.id===el.dataset.onnuriId);
   if(!x||x.direction!=='expense')return;
   const old={onnuri:x.onnuri,onnuriAuto:x.onnuriAuto,onnuriManual:x.onnuriManual};
   x.onnuri=!!el.checked;x.onnuriAuto=false;x.onnuriManual=true;
   if(!save()){Object.assign(x,old);return}
   render();toast(x.onnuri?'온누리상품권 결제로 표시했습니다.':'원본 결제수단 표시로 변경했습니다.');
   return;
 }
 if(el.id==='sheet-default-date'){if(/^\d{4}-\d{2}-\d{2}$/.test(el.value)){
   readSheetCells();const old=sheetData.date;sheetData.date=el.value;
   sheetData.rows.forEach(x=>{if(x.date===old)x.date=sheetData.date});render();
 }return}
 if(el.dataset.sheetField){
   const row=sheetData.rows[Number(el.dataset.sheetIndex)];
   if(el.dataset.sheetField==='onnuri'){
     if(row){row.onnuri=!!el.checked;row.onnuriTouched=true;row.onnuriAuto=false}
     return;
   }
   if(el.dataset.sheetField==='category'&&el.value==='__add__'){
     const type=el.closest('tr')?.querySelector('[data-sheet-field="ledgerType"]')?.value||'consumption';
     const name=prompt('추가할 대분류 이름을 입력하세요.','');
     if(!name){el.value=row?.category||'';return}
     try{
       editTax('add-major',type,'','',name);
       if(!save())return;
       el.innerHTML=sheetSelectOptions('category',{ledgerType:type,category:name});
       el.value=name;
       toast('대분류 "'+name.trim()+'"을 추가했습니다.');
     }catch(err){el.value=row?.category||'';toast(err.message);return}
   }
   if(row){
     row[el.dataset.sheetField]=el.value;
     if(el.dataset.sheetField==='scope')row.scopeManual=true;
     if(['merchant','payment'].includes(el.dataset.sheetField))syncSheetOnnuri(row,el.closest('tr'));
   }
   sheetSelectChange(el);
   if(row&&row.scope==='windmoon'&&['scope','category'].includes(el.dataset.sheetField))row.subcategory='풍월관';
   return;
 }
 if(['edit-merchant','edit-payment'].includes(el.id)){syncEditorOnnuriDefault();return}
 if(el.id==='edit-group'||el.id==='edit-category'){updateEditorSuggestions();return}
 if(el.id==='edit-scope'){
   const sub=$('#edit-subcategory');if(sub){
     if(el.value==='windmoon')sub.value='풍월관';
     else if(sub.value==='풍월관')sub.value='';
   }
   return;
 }
 if(el.id==='sales-month'){if(isMonth(el.value)){salesMonth=el.value;render()}return}
 if(el.id==='lotto-month'){if(isMonth(el.value)){lottoMonth=el.value;render()}return}
 if(el.id==='lotto-rate'){
   const rate=Number(el.value);if(!Number.isFinite(rate)||rate<0||rate>100){toast('수수료율은 0~100% 사이로 입력하세요.');return}
   state.lottoRatePct=rate;save();return
 }
 if(el.id==='bank-import-from'||el.id==='bank-import-to'){
   bankImportRange[el.id==='bank-import-from'?'from':'to']=el.value;preview=null;bankLoadToken++;
   try{validateBankRange(bankImportRange)}catch(e){toast(e.message);return}
   if(lastBankFile)void onBankFile(lastBankFile);else render();return;
 }
 if(el.id==='bank-file'){onBankFile(el.files?.[0]);el.value='';return}
 if(el.id==='legacy-file'){importLegacy(el.files?.[0]);el.value='';return}
 if(el.id==='period-filter'){period=el.value;offset=0;reviewOffset=0;render();return}
 if(el.id==='scope-filter'){scopeFilter=el.value;offset=0;render();return}
 if(el.id==='type-filter'){typeFilter=el.value;offset=0;render();return}
 if(el.id==='payment-filter'){paymentFilter=el.value;offset=0;render();return}
 if(el.id==='query-filter'){q=el.value;offset=0;render();$('#query-filter')?.focus();return}
}
function init(){
 restoreSheetDraft();
 load();
 sync=new GagebuSync.LedgerSync({getState:()=>state,
  applyRemote:data=>{
   try{
    if(corruptStorage){download('가계부_읽기오류_원본_'+now()+'.json',localStorage.getItem(KEY)||'','application/json;charset=utf-8')}
    const next={...blank(),...data},raw=JSON.stringify(next);localStorage.setItem(KEY,raw);
    state=next;persistedState=raw;corruptStorage=false;storageFailure='';render();return true;
   }catch{return false}
  },onStatus:()=>{refreshSaveStatus();if(page==='settings'&&!serverBusy&&!$('#server-login-form')?.contains(document.activeElement)){
    const section=$('.server-storage');if(section)section.outerHTML=serverSettings();
   }},onError:error=>toast(error.message),confirm:message=>confirm(message),
  backup:(data,label)=>download('가계부_'+label+'_'+new Date().toISOString().replace(/[:.]/g,'-')+'.json',JSON.stringify(data,null,2),'application/json;charset=utf-8')});
 const route=location.hash.replace(/^#/,'');if(VIEWS[route])page=route;
 document.addEventListener('click',onClick);
 document.addEventListener('change',onChange);
 document.addEventListener('change',()=>{if(page==='sheet')saveSheetDraft()});
 document.addEventListener('input',e=>{
   if(['edit-merchant','edit-payment'].includes(e.target.id))syncEditorOnnuriDefault();
   if(e.target.id==='refund-query')renderRefundCandidates();
   if(e.target.id==='query-filter'){
     clearTimeout(queryTimer);
     if(!e.isComposing){const start=e.target.selectionStart,end=e.target.selectionEnd,value=e.target.value;
       queryTimer=setTimeout(()=>{q=value;offset=0;render();const search=$('#query-filter');search?.focus();search?.setSelectionRange(start,end)},220);
     }
   }
   if(e.target.dataset?.sheetField){
     const row=sheetData.rows[Number(e.target.dataset.sheetIndex)];
     if(row&&e.target.dataset.sheetField!=='onnuri'){
       row[e.target.dataset.sheetField]=e.target.value;
       if(['merchant','payment'].includes(e.target.dataset.sheetField))syncSheetOnnuri(row,e.target.closest('tr'));
     }
   }
   const form=e.target.closest?.('.sales-form[data-sale-type="store"]');
   if(form&&['amount','netProfit'].includes(e.target.name)){
     const gross=numInput(form.querySelector('[name="amount"]').value);
     const raw=form.querySelector('[name="netProfit"]').value.trim(),profit=raw===''?null:signedInput(raw);
     const el=form.querySelector('#live-margin');
     if(el)el.textContent=marginDisplay(gross,profit);
   }
   if(e.target.matches?.('[data-lotto-input="handle"]')){
     const row=e.target.closest('tr'),commission=row?.querySelector('[data-lotto-input="commission"]'),handle=numInput(e.target.value);
     if(commission&&commission.value.trim()===''&&Number.isFinite(handle))commission.placeholder='예상 '+won(estimatedCommission(handle));
   }
   if(e.target.dataset?.sheetField)saveSheetDraft();
 });
 $('#editor-form').addEventListener('submit',e=>{e.preventDefault();submitEditor(e.target)});
 document.addEventListener('submit',e=>{
   if(e.target.id==='server-login-form'){e.preventDefault();void serverAction('login',e.target)}
   if(e.target.matches('.sales-form')){e.preventDefault();saveMonthlySale(e.target)}
   if(e.target.id==='lotto-daily-form'){e.preventDefault();saveLottoDaily(e.target)}
   if(e.target.dataset.taxAction){e.preventDefault();handleTaxForm(e.target)}
 });
 document.addEventListener('paste',pasteSheetGrid);
 document.addEventListener('keydown',e=>{
   if(sheetMove(e))return;
   if(e.key==='Escape'){$('#sidebar').classList.remove('open');$('#mobile-menu').setAttribute('aria-expanded','false')}
   if(page==='review'&&!$('#editor').open&&!e.altKey&&!e.ctrlKey&&!e.metaKey&&!/INPUT|TEXTAREA|SELECT|BUTTON|A/.test(document.activeElement?.tagName||'')){
     const row=$('.review-card');const id=row?.dataset.reviewId;
     const mapping={'1':'personal','2':'business','3':'windmoon'};
     if(id&&mapping[e.key]){e.preventDefault();chooseScope(id,mapping[e.key])}
   }
 }, true);
 const drop=$('#content');
 document.addEventListener('dragover',e=>{if(page==='import'&&e.dataTransfer?.types.includes('Files'))e.preventDefault()});
 document.addEventListener('drop',e=>{if(page!=='import'||!e.dataTransfer?.files?.length)return;e.preventDefault();onBankFile(e.dataTransfer.files[0])});
 window.addEventListener('storage',e=>{if(e.key===KEY&&e.newValue){try{const x=JSON.parse(e.newValue);if(GagebuValidation.validV2(x)){state=x;persistedState=e.newValue;sync.localChanged();render()}}catch(_){}}});
 window.addEventListener('online',()=>void sync.start());
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&sync.token)void sync.start()});
 window.addEventListener('hashchange',()=>{const route=location.hash.slice(1);if(VIEWS[route]&&route!==page)navigate(route)});
 document.addEventListener('click',e=>{if($('#sidebar').classList.contains('open')&&!e.target.closest('#sidebar,#mobile-menu')){$('#sidebar').classList.remove('open');$('#mobile-menu').setAttribute('aria-expanded','false')}});
 window.addEventListener('beforeunload',e=>{if(sync.flight||sync.token&&sync.meta.dirty){e.preventDefault();e.returnValue=''}});
 render();
 if(!corruptStorage)void sync.start();
}
init();
})();
