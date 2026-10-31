/* GAGEBU / Money Desk v2 — local-first, bank-import-driven. Never embeds private transaction data. */
(() => {
'use strict';
const KEY='gagebu-v2-private',OLD='gagebu-v1-data';
const $=(q,root=document)=>root.querySelector(q),$$=(q,root=document)=>Array.from(root.querySelectorAll(q));
const E=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
const n=s=>Number(s)||0,won=v=>Math.round(n(v)).toLocaleString('ko-KR')+'원',ym=()=>new Date().toISOString().slice(0,7);
const now=()=>new Date().toISOString().slice(0,10),uid=()=>crypto.randomUUID();
const G=window.GagebuRules;
const VIEWS={dashboard:'전체 요약',records:'전체 거래내역',sheet:'시트형 입력',sales:'월매출 입력',lotto:'토토 일별 매출',review:'미분류 검토함',import:'거래 가져오기',rules:'분류 기준',settings:'데이터 · 설정'};
const LABEL={personal:'개인',business:'편의점',windmoon:'풍월관',review:'미분류',excluded:'제외',transfer:'이체'};
const GROUP={fixed:'고정지출',consumption:'소비지출'};
const SOURCE={bank:'뱅크샐러드',legacy:'구글 시트',manual:'직접 입력'};
/* Actual payment funding is distinct from the BankSalad registered card display.
   Onnuri is a prepaid balance: its top-ups are excluded, usage is a single expense. */
const isOnnuri=x=>x.onnuri===true||(!('onnuri' in x)&&/온누리/.test(String(x.payment||'')));
const paymentLabel=x=>isOnnuri(x)?'온누리상품권':String(x.payment||'—');
const registeredCard=x=>isOnnuri(x)?String(x.bankPayment||(/온누리/.test(String(x.payment||''))?'':x.payment)||''):'';
const onnuriCheckbox=(x,location)=>'<label class="onnuri-choice"><input type="checkbox" data-onnuri-id="'+E(x.id)+'" '+(isOnnuri(x)?'checked':'')+' aria-label="'+E(x.merchant||'거래')+' 온누리상품권 사용 여부">'+
  '<span>온누리상품권으로 결제</span></label>';

const blank=()=>({version:2,records:[],dailyLotto:[],storeProfits:{},lottoRatePct:5.97,customRules:{},rentRecipients:{},imports:[],excludedAudit:[],createdAt:new Date().toISOString()});
let state=blank(),page='dashboard',period='all',scopeFilter='all',typeFilter='all',q='',offset=0,reviewOffset=0,preview=null,editing=null,toastTimer=null,shownTip=false,salesMonth=ym(),lottoMonth=ym(),bankImportRange={from:'2026-01-01',to:now()},lastBankFile=null,bankLoadToken=0;
const dateDiff=(a,b)=>Math.abs((Date.parse(a+'T00:00:00Z')-Date.parse(b+'T00:00:00Z'))/86400000);
const money=val=>Math.abs(Number(val)||0);
const escAttr=E;
const ledgerScope=x=>{
 if(/풍월관/.test(String(x.note||'')+' '+String(x.category||'')))return 'windmoon';
 if(x.area==='business')return 'business';
 if(x.area==='review')return 'review';
 if(x.area==='transfer')return 'transfer';
 return 'personal';
};
function migrateLegacy(data){
 if(!data||!Array.isArray(data.transactions))throw Error('가게부 원본 형식이 아닙니다.');
 const entries=data.transactions.map(x=>({
  id:'old-'+String(x.id),date:String(x.date||''),time:'',amount:money(x.amount),
  direction:x.kind==='income'?'income':x.kind==='transfer'?'transfer':'expense',
  scope:ledgerScope(x),ledgerType:x.sourceSheet==='고정지출'?'fixed':x.sourceSheet==='소비지출'?'consumption':'',
  category:String(x.category||''),subcategory:String(x.subcategory||''),
  merchant:String(x.merchant||''),payment:String(x.payment||''),onnuri:/온누리/.test(String(x.payment||'')),note:String(x.note||''),
  source:'legacy',sourceSheet:String(x.sourceSheet||'직접 입력'),sourceId:String(x.id),sourceRow:x.sourceRow??null,
  originalArea:String(x.area||''),status:ledgerScope(x)==='review'?'review':'confirmed',manual:false,bankKey:''
 }));
 return entries.filter(x=>x.date.startsWith('2026-'));
}

const numInput=raw=>{
 const s=String(raw??'').replace(/[,\s₩원]/g,'');
 return /^\d+$/.test(s)?Number(s):NaN;
};
const signedInput=raw=>{const s=String(raw??'').replace(/[,\s₩원]/g,'');return /^-?\d+$/.test(s)?Number(s):NaN;};
const normalizeDailyLotto=x=>{
 const date=String(x?.date||'');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!date.startsWith('2026-'))return null;
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
 try{localStorage.setItem(KEY,JSON.stringify(state));setStatus('이 브라우저에 저장됨');return true}
 catch(err){toast('브라우저 저장 공간 부족: 백업 후 데이터를 확인해 주세요.');return false}
}
function load(){
 let hadV2=false;
 try{
   const existing=JSON.parse(localStorage.getItem(KEY)||'null');
   if(existing&&existing.version===2&&Array.isArray(existing.records)){
     state={...blank(),...existing};
     if(!Array.isArray(state.dailyLotto))state.dailyLotto=[];
     if(!state.storeProfits||typeof state.storeProfits!=='object')state.storeProfits={};
     hadV2=true;
   }
 }catch(err){console.warn('V2 load failed',err)}
 try{
   const legacy=JSON.parse(localStorage.getItem(OLD)||'null');
   if(legacy&&Array.isArray(legacy.transactions)){
     if(!hadV2){state.records=migrateLegacy(legacy);state.migratedFromV1=true;}
     const merged=mergeDailyLotto(legacy.dailyLotto);
     if(!hadV2||merged.added)save();
   }
 }catch(err){console.warn('Legacy load failed',err)}
}
const relevant=()=>state.records.filter(x=>x.status!=='excluded'&&x.direction==='expense');
const filtered=(list)=>list.filter(x=>(period==='all'||x.date.slice(0,7)===period)&&(scopeFilter==='all'||x.scope===scopeFilter)&&(typeFilter==='all'||x.ledgerType===typeFilter)&&(q===''||[x.merchant,x.category,x.subcategory,x.note,x.payment,x.date].join(' ').toLocaleLowerCase('ko').includes(q.toLocaleLowerCase('ko'))));
const monthlyOptions=()=>{
 const months=new Set([...state.records.map(x=>x.date.slice(0,7)),...(state.dailyLotto||[]).map(x=>x.date.slice(0,7))].filter(x=>/^20\d\d-\d\d$/.test(x)));
 for(let m=1;m<=12;m++)months.add('2026-'+String(m).padStart(2,'0'));
 return ['<option value="all">전체 기간</option>',...[...months].sort().reverse().map(m=>'<option value="'+m+'"'+(m===period?' selected':'')+'>'+m.slice(0,4)+'년 '+Number(m.slice(5))+'월</option>')].join('');
};
const statusBadge=x=>x.status==='review'?'<span class="tag tag-warn">분류 대기</span>':x.status==='excluded'?'<span class="tag tag-muted">제외됨</span>':'<span class="tag tag-ok">분류 완료</span>';
const scopeBadge=x=>'<span class="tag tag-'+E(x.scope)+'">'+E(LABEL[x.scope]||'미분류')+'</span>';
const sum=list=>list.reduce((v,x)=>v+n(x.amount),0);
function setStatus(msg){const el=$('#save-indicator');if(el)el.textContent=msg}
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
 return '<div class="filter-row"><select id="period-filter" aria-label="조회 기간">'+monthlyOptions()+'</select><select id="scope-filter" aria-label="사용처"><option value="all">모든 사용처</option>'+Object.entries(LABEL).filter(([k])=>k!=='transfer'&&k!=='excluded').map(([k,v])=>'<option value="'+k+'"'+(scopeFilter===k?' selected':'')+'>'+v+'</option>').join('')+'</select><select id="type-filter" aria-label="장부 유형"><option value="all">모든 지출 종류</option>'+Object.entries(GROUP).map(([k,v])=>'<option value="'+k+'"'+(typeFilter===k?' selected':'')+'>'+v+'</option>').join('')+'</select><input id="query-filter" class="search" type="search" autocomplete="off" placeholder="거래처 · 메모 · 결제수단 검색" value="'+E(q)+'"></div>';
}
function dashboard(){
 const all=relevant().filter(x=>period==='all'||x.date.slice(0,7)===period);
 const personal=all.filter(x=>x.scope==='personal'),business=all.filter(x=>x.scope==='business'),windmoon=all.filter(x=>x.scope==='windmoon'),review=all.filter(x=>x.scope==='review');
 const groupTotals=Object.entries(GROUP).map(([key,title])=>({title,total:sum(all.filter(x=>x.ledgerType===key))}));
 const categories=Object.entries(all.filter(x=>x.scope!=='review').reduce((a,x)=>{a[x.category]=(a[x.category]||0)+x.amount;return a},{})).sort((a,b)=>b[1]-a[1]).slice(0,9);
 const max=Math.max(1,...categories.map(x=>x[1]));
 const recent=all.slice().sort((a,b)=>b.date.localeCompare(a.date)||b.time.localeCompare(a.time)).slice(0,8);
 const top=pageIntro('MONEY OVERVIEW','매출과 지출을 한눈에','편의점 총매출 + 토토 확정 수수료를 수입으로 집계하고, 개인·편의점·풍월관 지출을 구분합니다.',topFilters());
 return top+
 '<div class="stat-grid">'+statCard('개인 소비',sum(personal),personal.length+'건 · 개인 장부','blue','◉')+
 statCard('편의점 매입 · 운영',sum(business),business.length+'건 · 편의점 장부','teal','▤')+
 statCard('풍월관 관련',sum(windmoon),windmoon.length+'건 · 별도 관리','violet','◈')+
 statCard('미분류 대기',sum(review),review.length+'건 · 판단 전 합계에서 분리','amber','?')+'</div>'+
 '<section class="surface sales-overview"><div class="surface-head"><div><h2>POS 월매출 요약</h2><p>편의점 매출·토토 월 확정 수수료는 직접 입력한 기록만 집계합니다.</p></div><button class="btn subtle" data-nav="sales">월매출 입력 →</button></div>'+
 '<div class="sales-overview-grid"><div><span>편의점 매출</span><strong>'+won(revenueTotal('store'))+'</strong></div>'+
 '<div><span>토토 월 확정 수수료</span><strong>'+won(revenueTotal('lotto'))+'</strong></div>'+
 '<div><span>매출 합계</span><strong>'+won(revenueTotal('store')+revenueTotal('lotto'))+'</strong></div></div></section>'+
 '<section class="surface finance-overview"><div class="surface-head"><div><h2>수입 − 지출 · 장부 수지</h2><p>총매출 기준, 토토는 확정 수수료만 적용합니다. 미분류 지출은 제외되어 잠정 수지일 수 있습니다.</p></div><button class="btn subtle" data-nav="sales">월매출 관리 →</button></div>'+
 '<div class="sales-overview-grid"><div><span>확정 수입</span><strong>'+won(financials(period).income)+'</strong></div>'+
 '<div><span>분류 완료 지출</span><strong>'+won(financials(period).expenses)+'</strong></div>'+
 '<div><span>장부 수지</span><strong>'+won(financials(period).balance)+'</strong></div></div></section>'+
 '<div class="dash-columns"><section class="surface"><div class="surface-head"><div><h2>지출 항목 TOP 9</h2><p>분류 완료한 거래 기준, 풍월관 금액은 별도 항목으로 표시</p></div></div>'+
 (categories.length?'<div class="category-chart">'+categories.map(([name,value])=>'<div class="chart-line"><div class="chart-meta"><span>'+E(name)+'</span><strong>'+won(value)+'</strong></div><div class="chart-bar"><i style="width:'+Math.max(2,value/max*100).toFixed(2)+'%"></i></div></div>').join('')+'</div>':'<div class="empty">금융내역을 가져오면 항목별 지출이 표시됩니다.</div>')+'</section>'+
 '<section class="surface summary-panel"><div class="surface-head"><div><h2>장부 구분</h2><p>고정지출 = 원본 시트 분류 · 고정비와 다름</p></div></div>'+
 groupTotals.map(x=>'<div class="summary-line"><span>'+x.title+'</span><strong>'+won(x.total)+'</strong></div>').join('')+
 '<div class="notice"><b>집계 원칙</b><p>풍월관 관련 지출은 편의점 사업비나 개인 소비에 합산하지 않습니다. 미분류도 확정 지출로 계산하지 않습니다.</p></div>'+
 '<button class="btn primary wide" data-nav="review">미분류 거래 검토하기 <span>→</span></button></section></div>'+
 '<section class="surface"><div class="surface-head"><div><h2>최근 거래</h2><p>거래처는 뱅크샐러드 원문을 우선 표시합니다. 원본 시트에만 있던 거래는 별도 표시합니다.</p></div><button class="btn subtle" data-nav="records">전체 거래 보기 →</button></div>'+transactionTable(recent,true)+'</section>';
}
function transactionTable(items,compact=false){
 return '<div class="table-scroll"><table class="records-table"><thead><tr><th>날짜 · 시간</th><th>거래처</th><th>결제 수단</th><th>분류</th><th class="right">금액</th><th>관리</th></tr></thead><tbody>'+
 (items.length?items.map(x=>'<tr><td class="date-col">'+E(x.date)+'<small>'+E(x.time||'')+'</small></td>'+
 '<td class="merchant-col"><strong>'+E(x.merchant||'거래처 미기재')+'</strong><small>'+E((x.source==='bank'?'뱅크샐러드':x.sourceSheet||SOURCE[x.source]||'직접 입력'))+'</small></td>'+
 '<td class="payment-col"><strong class="payment-main">'+E(paymentLabel(x))+'</strong>'+
  (registeredCard(x)?'<small>뱅샐 원본 카드: '+E(registeredCard(x))+'</small>':'')+
  (x.direction==='expense'?onnuriCheckbox(x,'table'):'')+'</td>'+
 '<td>'+scopeBadge(x)+'<small class="cat-text">'+E([x.category,x.subcategory].filter(Boolean).join(' / ')||'미분류')+'</small></td>'+
 '<td class="right amount-col">−'+won(x.amount)+'</td><td><button class="row-edit" data-edit="'+E(x.id)+'">수정</button></td></tr>').join(''):
 '<tr><td colspan="6"><div class="empty">표시할 거래가 없습니다.</div></td></tr>')+'</tbody></table></div>';
}
function reviewCard(x,i){
 const online=x.category==='온라인쇼핑'||/온라인 쇼핑/.test(x.reason||'');
 const suggest=x.matchCandidate?'<span class="match-flag">원장에 유사한 거래가 있습니다 · 중복 확인 필요</span>':'';
 return '<article class="review-card" data-review-id="'+E(x.id)+'"><div class="review-index">'+String(i+1).padStart(2,'0')+'</div><div class="review-main"><div class="review-top"><strong>'+E(x.merchant||'거래처 미기재')+'</strong><span>−'+won(x.amount)+'</span></div>'+
 '<div class="review-metadata">'+E(x.date)+' · '+E(paymentLabel(x))+
  (registeredCard(x)?' (등록 카드: '+E(registeredCard(x))+')':'')+
  ' · '+E([x.bankMajor,x.bankMinor].filter(Boolean).join(' / '))+'</div>'+onnuriCheckbox(x,'review')+
 '<p class="review-reason">'+E(x.reason||'분류 확인 필요')+'</p>'+suggest+
 '<div class="review-choices"><button data-scope="personal" data-id="'+E(x.id)+'" class="choice personal"><b>1</b> 개인 소비</button>'+
 '<button data-scope="business" data-id="'+E(x.id)+'" class="choice business"><b>2</b> 편의점 매입</button>'+
 '<button data-scope="windmoon" data-id="'+E(x.id)+'" class="choice windmoon"><b>3</b> 풍월관</button>'+
 '<button data-edit="'+E(x.id)+'" class="choice secondary">세부 수정</button><button data-scope="exclude" data-id="'+E(x.id)+'" class="choice exclude">제외</button></div>'+
 (online?'<small class="online-help">온라인 쇼핑 거래처는 같은 곳에서도 용도가 달라집니다. 거래별로 선택합니다.</small>':'')+
 '</div></article>';
}
function reviewPage(){
 const list=state.records.filter(x=>x.direction==='expense'&&x.status==='review'&&(period==='all'||x.date.slice(0,7)===period)).sort((a,b)=>b.date.localeCompare(a.date));
 const online=list.filter(x=>x.category==='온라인쇼핑').length;
 return pageIntro('REVIEW INBOX','분류가 필요한 거래','애매한 거래를 임의 분류하지 않았습니다. 개인·편의점·풍월관 버튼 중 하나를 누르면 즉시 해당 장부로 이동합니다.',
 '<select id="period-filter" aria-label="조회 기간">'+monthlyOptions()+'</select>')+
 '<div class="review-summary"><div><strong>'+list.length.toLocaleString('ko-KR')+'건</strong><span>분류 대기</span></div><div><strong>'+online.toLocaleString('ko-KR')+'건</strong><span>온라인쇼핑 확인</span></div><div><strong>'+won(sum(list))+'</strong><span>미반영 검토 금액</span></div></div>'+
 '<div class="review-header"><div><h2>빠른 분류</h2><p>거래처와 결제수단을 보고 바로 선택하세요. 확정 후에도 거래내역에서 수정할 수 있습니다.</p></div><div class="shortcuts">개인 <kbd>1</kbd> 편의점 <kbd>2</kbd> 풍월관 <kbd>3</kbd></div></div>'+
 '<div class="review-list">'+(list.length?list.slice(reviewOffset,reviewOffset+35).map((x,i)=>reviewCard(x,reviewOffset+i)).join(''):'<div class="empty spacious"><b>모든 거래의 분류가 완료됐습니다.</b><p>다음 뱅크샐러드 파일을 가져오면 새 검토 항목이 나타납니다.</p></div>')+'</div>'+
 (list.length>35?'<div class="pager"><button class="btn" data-review-page="prev" '+(reviewOffset===0?'disabled':'')+'>이전</button><span>'+(reviewOffset+1)+'–'+Math.min(reviewOffset+35,list.length)+' / '+list.length+'</span><button class="btn" data-review-page="next" '+(reviewOffset+35>=list.length?'disabled':'')+'>다음</button></div>':'');
}

const SHEET_CATS={
 fixed:{
  '담배 발주':['KT&G','말보로','메비우스','던힐'],
  '발주':['쿠팡','지마켓','네이버','상온','주류','미스터파크','기타'],
  '가게':['임대료','전기료','통신료','보안업체','가맹비','점소모품','스포츠 토토','기타'],
  '집':['월세','전기료','통신료','수도세','가스요금'],
  '보험':['KB암보험','KB주가지수','메리츠','삼성화재','KB7년의약속','기타'],
  '건보/연금':['국민연금','건강보험'],
  '세금':['부가가치세','종합소득세','지방세','세무사 기장료'],
  '월정액':['11번가','쿠팡','지마켓','네이버','기타'],
  '기타':['카드연회비','가족회비','기타']
 },
 consumption:{
  '편의점':[],'식재료':[],'외식/배달':[],'병원/약국':[],'건강/미용':[],
  '쇼핑':['온라인','오프라인'],'온라인쇼핑':[],'여행':[],'교통비':[],'풍월관':[],'기타':[]
 }
};
const SHEET_FIELDS=['date','amount','scope','ledgerType','category','subcategory','merchant','payment','note'];
const SHEET_TITLES={date:'날짜',amount:'금액 (원)',scope:'사용처',ledgerType:'지출 종류',category:'대분류',subcategory:'소분류',merchant:'거래처',payment:'결제수단',note:'메모'};
const sheetData={rows:[],date:now(),limit:200};
const sheetNewRow=()=>({date:sheetData.date,amount:'',scope:'personal',scopeManual:false,ledgerType:'consumption',category:'',subcategory:'',merchant:'',payment:'',note:''});
const sheetOptions=(items,current)=>items.map(([val,label])=>'<option value="'+E(val)+'"'+(val===current?' selected':'')+'>'+E(label)+'</option>').join('');
function sheetSelectOptions(field,row){
 if(field==='scope')return sheetOptions([['personal','개인'],['business','편의점'],['windmoon','풍월관'],['review','미분류']],row.scope);
 if(field==='ledgerType')return sheetOptions([['consumption','소비지출'],['fixed','고정지출']],row.ledgerType);
 if(field==='category')return sheetOptions([['','대분류 선택'],...Object.keys(SHEET_CATS[row.ledgerType]||{}).map(c=>[c,c])],row.category);
 return sheetOptions([['','소분류 선택 (선택)'],...(SHEET_CATS[row.ledgerType]?.[row.category]||[]).map(c=>[c,c])],row.subcategory);
}
function sheetCell(field,row,index){
 const v=String(row[field]??''),attrs='data-sheet-field="'+field+'" data-sheet-index="'+index+'" aria-label="'+(index+1)+'행 '+SHEET_TITLES[field]+'"';
 if(['scope','ledgerType','category'].includes(field))return '<select '+attrs+'>'+sheetSelectOptions(field,row)+'</select>';
 if(field==='subcategory')return '<input '+attrs+' type="text" list="sheet-sub-'+index+'" placeholder="소분류 (선택)" value="'+E(v)+'"><datalist id="sheet-sub-'+index+'">'+
   (SHEET_CATS[row.ledgerType]?.[row.category]||[]).map(x=>'<option value="'+E(x)+'"></option>').join('')+'</datalist>';
 return '<input '+attrs+' type="'+(field==='date'?'date':'text')+'"'+(field==='amount'?' inputmode="numeric"':'')+
   ' autocomplete="off" placeholder="'+(field==='merchant'?'거래처 입력':field==='amount'?'금액':field==='payment'?'카드·현금':'')+'" value="'+E(v)+'">';
}
function sheetRowMarkup(row,i){
 return '<tr data-sheet-row="'+i+'"><th scope="row">'+(i+1)+'</th>'+
   SHEET_FIELDS.map(field=>'<td data-sheet-col="'+field+'">'+sheetCell(field,row,i)+'</td>').join('')+
   '<td><button type="button" class="row-edit" data-sheet-delete="'+i+'" aria-label="'+(i+1)+'행 삭제">×</button></td></tr>';
}
function sheetPage(){
 if(!sheetData.rows.length)sheetData.rows=Array.from({length:10},sheetNewRow);
 return pageIntro('SHEET INPUT','시트형 일괄 입력','기존 엑셀형 입력창을 복구했습니다. 현금 발주·사업비 등 직접 기록할 지출을 여러 행에 작성하고 한 번에 저장합니다.')+
 '<section class="surface sheet-entry"><div class="surface-head"><div><h2>지출 일괄 입력</h2><p>Enter·Tab·방향키로 셀 이동 · Excel에서 여러 칸 복사/붙여넣기 · 대분류에 따른 소분류 추천</p></div>'+
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
 const rows=$('tbody tr',table);
 sheetData.rows=rows.map((tr,index)=>{
   const out={scopeManual:!!sheetData.rows[index]?.scopeManual};
   for(const f of SHEET_FIELDS)out[f]=tr.querySelector('[data-sheet-field="'+f+'"]')?.value??'';
   return out;
 });
}
function rerenderSheet(focusIndex,focusField){
 const scroll=$('#sheet-entry-scroll'),top=scroll?.scrollTop,left=scroll?.scrollLeft;
 render();
 const next=$('[data-sheet-index="'+focusIndex+'"][data-sheet-field="'+focusField+'"]');
 if(scroll){const nowScroll=$('#sheet-entry-scroll');nowScroll.scrollTop=top;nowScroll.scrollLeft=left}
 next?.focus();
}
function sheetRowFromInput(row,i){
 const content=SHEET_FIELDS.some(k=>!['date','scope','ledgerType'].includes(k)&&String(row[k]||'').trim());
 if(!content)return null;
 const date=String(row.date||'').trim(),amount=numInput(row.amount),scope=String(row.scope||''),type=String(row.ledgerType||''),
  category=String(row.category||'').trim(),merchant=String(row.merchant||'').trim();
 const fail=msg=>{throw Error((i+1)+'행: '+msg)};
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date<'2026-01-01'||Number.isNaN(Date.parse(date+'T00:00:00Z')))fail('올바른 날짜를 입력하세요');
 if(!Number.isSafeInteger(amount)||amount<=0)fail('금액은 0보다 커야 합니다');
 if(!['personal','business','windmoon','review'].includes(scope))fail('사용처를 선택하세요');
 if(!['consumption','fixed'].includes(type))fail('지출 종류를 선택하세요');
 if(!category)fail('대분류를 선택하세요');
 if(!merchant)fail('거래처를 입력하세요');
 const value={id:'manual-sheet-'+uid(),date,time:'',amount,direction:'expense',scope,ledgerType:type,
  category,subcategory:String(row.subcategory||'').trim(),merchant,payment:String(row.payment||'').trim(),
  note:String(row.note||'').trim(),status:scope==='review'?'review':'confirmed',manual:true,
  source:'manual',sourceSheet:'시트형 직접 입력',bankKey:''};
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
 const count=state.records.length;state.records.push(...candidates);
 if(!save()){state.records.length=count;return}
 sheetData.rows=Array.from({length:10},sheetNewRow);
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
   if(f==='scope'&&!['personal','business','windmoon','review'].includes(v))continue;
   if(f==='ledgerType'&&!['fixed','consumption'].includes(v))continue;
   if(f==='category'&&!Object.keys(SHEET_CATS[entry.ledgerType]||{}).includes(v))continue;
   entry[f]=v;
 }
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
 if(current)current[el.dataset.sheetField]=el.value; // do not discard last edited cell
 if(row>=sheetData.limit){toast('한 번에 최대 '+sheetData.limit+'행까지 입력할 수 있습니다.');return true}
 while(row>=sheetData.rows.length){
   const newRow=sheetNewRow();
   sheetData.rows.push(newRow);
   const body=$('#sheet-entry-table tbody');
   if(body)body.insertAdjacentHTML('beforeend',sheetRowMarkup(newRow,sheetData.rows.length-1));
 }
 const next=$('[data-sheet-index="'+row+'"][data-sheet-field="'+SHEET_FIELDS[col]+'"]');
 if(next){next.focus({preventScroll:false});if(next.tagName==='INPUT'&&next.type!=='date')next.select?.()}
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
   if(sub){sub.value='';const list=tr.querySelector('datalist');if(list)list.innerHTML=(SHEET_CATS[tr.querySelector('[data-sheet-field="ledgerType"]').value]?.[el.value]||[]).map(v=>'<option value="'+E(v)+'"></option>').join('')}
 }
 // Do not overwrite a manually selected owner; only infer when owner is still default.
 const category=tr.querySelector('[data-sheet-field="category"]')?.value||'',
       scope=tr.querySelector('[data-sheet-field="scope"]');
 if(scope&&!sheetData.rows[Number(el.dataset.sheetIndex)]?.scopeManual&&el.dataset.sheetField==='category'){
   const nextScope=['발주','담배 발주','가게'].includes(category)?'business':category==='풍월관'?'windmoon':'personal';
   scope.value=nextScope;
 }
}

function recordsPage(){
 const entries=filtered(state.records.filter(x=>x.direction==='expense'&&x.status!=='excluded')).sort((a,b)=>b.date.localeCompare(a.date)||b.time.localeCompare(a.time));
 return pageIntro('TRANSACTIONS','전체 거래내역','은행에서 가져온 거래와 원본 시트의 현금 지출을 함께 관리합니다. 원본 출처와 거래처 정보를 보존합니다.',
 '<button class="btn primary" id="new-record">＋ 직접 입력</button>')+
 '<section class="surface records-surface">'+topFilters()+
 '<div class="table-topline"><span>조회 결과 <b>'+entries.length.toLocaleString('ko-KR')+'건</b></span><strong>합계 '+won(sum(entries.filter(x=>x.scope!=='review'&&x.scope!=='windmoon')))+'</strong></div>'+
 transactionTable(entries.slice(offset,offset+80))+
 '<div class="pager"><button class="btn" data-page-step="-1" '+(offset===0?'disabled':'')+'>이전</button><span>'+(entries.length?offset+1:0)+'–'+Math.min(offset+80,entries.length)+' / '+entries.length+'</span><button class="btn" data-page-step="1" '+(offset+80>=entries.length?'disabled':'')+'>다음</button></div></section>';
}
function importPage(){
 return pageIntro('DATA IMPORT','금융내역 가져오기','모든 분석은 브라우저 내부에서만 실행됩니다. 민감한 금융 엑셀은 공개 GitHub나 외부 서버에 업로드하지 않습니다.')+
 '<div class="import-grid"><section class="surface upload-panel"><div class="step"><span>02</span><div><h2>뱅크샐러드 엑셀</h2><p>선택 기간 자료 분석 · 거래처 원문 보존 · 토토/투자/수입/불필요한 이체 제외</p></div></div>'+
 '<div class="bank-range"><strong>가져올 거래 기간</strong><small>시작일과 종료일 포함 · 선택 기간의 거래만 등록</small>'+
 '<label>시작일 <input id="bank-import-from" type="date" value="'+E(bankImportRange.from)+'"></label>'+
 '<label>종료일 <input id="bank-import-to" type="date" value="'+E(bankImportRange.to)+'"></label></div>'+
 '<label class="dropzone" id="bank-drop"><input id="bank-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"><span class="drop-icon">⇧</span><strong>뱅크샐러드 XLSX 선택</strong><small>엑셀 파일을 클릭하거나 여기에 끌어다 놓으세요</small></label>'+
 '<div class="import-detail"><span>기존 거래와 날짜·금액·결제수단을 대조해 중복을 줄입니다.</span><span>카드 재발급으로 사라진 거래는 기존 시트에서 보존합니다.</span></div></section>'+
 '<section class="surface upload-panel"><div class="step"><span>01</span><div><h2>기존 가게부 가져오기</h2><p>구글 시트 이관 JSON을 기준 장부로 합칩니다. 예전에 브라우저에 저장한 자료는 자동 복사하며 원본은 유지합니다.</p></div></div>'+
 '<label class="dropzone secondary-drop"><input id="legacy-file" type="file" accept=".json,application/json"><span class="drop-icon">▦</span><strong>가게부 JSON 파일 선택</strong><small>기존 구글 시트 이관 파일 · 데이터 백업 파일</small></label>'+
 '<div class="notice compact"><b>원본 보존</b><p>기존 현금 주류 발주와 오프라인 거래는 뱅크샐러드에 없다고 해서 삭제하지 않습니다.</p></div></section></div>'+
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
 '<div class="import-actions"><button class="btn subtle" id="discard-import">미리보기 취소</button><button class="btn primary" id="commit-bank">확인한 거래 가져오기 ('+p.newItems.length+'건)</button></div></section>';
}
function rulesPage(){
 const fixed=[
 ['스포츠토토 관련','모든 입·출금 수집 제외','토토 운영대금·당첨금 송금 및 미확인 개인 송금은 지출로 계산하지 않음'],
 ['온누리 충전','선불 충전 거래 제외','실제 사용 건과 충전액을 동시에 소비로 계산하지 않음'],
 ['주식·증권·투자','전체 제외','자산 거래는 가게부 소비 지출에서 배제'],
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
 const expenses=state.records.filter(x=>x.direction==='expense'&&x.status==='confirmed'&&x.scope!=='excluded'&&x.scope!=='review'&&(selected==='all'||x.date.slice(0,7)===selected));
 return {income,expenses:sum(expenses),balance:income-sum(expenses),unreviewed:sum(state.records.filter(x=>x.direction==='expense'&&x.status==='review'&&(selected==='all'||x.date.slice(0,7)===selected)))};
}
function revenueTotal(type,selected=period){
 return sum(state.records.filter(x=>x.direction==='income'&&x.category===SALES[type].category&&x.status!=='excluded'&&(selected==='all'||x.date.slice(0,7)===selected)));
}
function upsertSale(month,type,amount,note,netProfit){
 if(!isMonth(month)||!SALES[type]||!Number.isSafeInteger(amount)||amount<0)throw Error('월·금액을 확인하세요.');
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
   '<button class="btn primary wide" type="submit" '+(x.count>1?'disabled':'')+'>'+(x.count===1?'✓ 수정 저장':'＋ 등록')+' <span>→</span></button></form>';
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
 if(!Number.isSafeInteger(amount)||amount<0){toast('월 금액은 0 이상의 숫자로 입력하세요.');return}
 let profit;
 if(type==='store'){
   const raw=String(data.get('netProfit')??'').trim();profit=raw===''?null:signedInput(raw);
   if(profit!==null&&!Number.isSafeInteger(profit)){toast('순이익을 올바르게 입력하세요.');return}
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
    '<td><input data-lotto-input="commission" type="text" inputmode="numeric" aria-label="'+date+' 수수료" value="'+(x?E(x.commission.toLocaleString('ko-KR')):'')+'" placeholder="예상 자동계산"></td></tr>';
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
 '<form id="lotto-daily-form"><div class="table-scroll"><table class="records-table lotto-day-table"><thead><tr><th>날짜</th><th>판매액 (원)</th><th>실제 수수료 (원)</th></tr></thead><tbody>'+
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
   if(!Number.isSafeInteger(handle)||handle<0||!Number.isSafeInteger(commission)||commission<0){errors.push(date+' 금액 형식 오류');continue}
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
function settingsPage(){
 return pageIntro('DATA & PRIVACY','데이터 · 설정','서버 이전 전까지 현재 자료는 이 브라우저에만 저장됩니다. 기존 v1 장부를 삭제하거나 덮어쓰지 않습니다.')+
 '<section class="settings-grid"><div class="surface settings-box"><div class="surface-head"><div><h2>데이터 백업</h2><p>금융 정보와 거래처가 포함된 개인 파일입니다.</p></div></div>'+
 '<button class="btn primary wide" id="export-json">JSON 전체 백업 내려받기</button><button class="btn subtle wide" id="export-csv">CSV 거래내역 내려받기</button>'+
 '<div class="notice compact"><b>보안</b><p>백업 파일은 개인 기기 또는 암호화된 저장소에 보관하세요. 공개 GitHub에 업로드하면 안 됩니다.</p></div></div>'+
 '<div class="surface settings-box"><div class="surface-head"><div><h2>연결 상태</h2><p>Cloudflare D1 서버는 아직 연결하지 않았습니다.</p></div></div>'+
 '<div class="summary-line"><span>저장 방식</span><strong>현재 브라우저</strong></div><div class="summary-line"><span>거래내역</span><strong>'+state.records.length.toLocaleString('ko-KR')+'건</strong></div><div class="summary-line"><span>금융 파일 가져오기</span><strong>'+state.imports.length+'회</strong></div><div class="summary-line"><span>기존 가게부 v1</span><strong>별도 보존</strong></div>'+
 '<a class="text-link" href="./legacy.html">이전 가게부 화면 열기 ↗</a></div></section>'+
 '<div class="notice"><b>서버 전환 준비</b><p>현재 버전은 로컬 데이터 모델을 독립적으로 관리합니다. 향후 Workers + D1 구축 시 저장 어댑터만 전환하도록 분리했습니다. 아직 자동 동기화가 된다고 표시하지 않습니다.</p></div>';
}
function render(){
 $('#page-title').textContent=VIEWS[page]||'가게부';$$('[data-nav]').forEach(el=>el.classList.toggle('active',el.dataset.nav===page));
 const navCount=$('#review-count');if(navCount){const ct=state.records.filter(x=>x.status==='review'&&x.direction==='expense').length;navCount.textContent=ct?ct.toLocaleString('ko-KR'):'';navCount.hidden=!ct}
 const container=$('#content');
 container.innerHTML=({dashboard,review:reviewPage,records:recordsPage,sheet:sheetPage,sales:salesPage,lotto:lottoPage,import:importPage,rules:rulesPage,settings:settingsPage})[page]();
 $('#sidebar').classList.remove('open');
 setStatus('이 브라우저에 저장됨');
}
function navigate(p){
 if(!VIEWS[p])return;
 if(p==='lotto'&&page==='sales')lottoMonth=salesMonth;
 if(p==='sales'&&page==='lotto')salesMonth=lottoMonth;
 page=p;offset=0;reviewOffset=0;scopeFilter='all';typeFilter='all';q='';
 location.hash='#'+p;render();window.scrollTo(0,0);
}
function patchRecord(id,updates){
 const row=state.records.find(x=>x.id===id);if(!row)return;
 Object.assign(row,updates);
 if(row.scope==='excluded')row.status='excluded';
 else if(row.scope!=='review')row.status='confirmed';
 save();render();
}
function chooseScope(id,scope){
 const row=state.records.find(x=>x.id===id);if(!row)return;
 const classification=G.classifyChoice(scope,row);
 const corrected={...classification};
 delete corrected.action;delete corrected.confidence;
 patchRecord(id,corrected);
 toast(scope==='exclude'?'거래를 지출 합계에서 제외했습니다.':LABEL[scope]+'으로 분류했습니다.');
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
async function processBank(file,range=bankImportRange){
 const bounds=validateBankRange(range);
 const parsed=await window.BankSaladXLSX.parseBankSalad(file);
 const existing=new Set(state.records.map(x=>x.bankKey).filter(Boolean));
 const source=state.records.filter(x=>x.source!=='bank'&&x.direction==='expense');
 const used=new Set(),counts={},all=[],links=[];
 const duplicates=new Map();let reviewCount=0,outOfRange=0;
 const count=r=>{counts[r]=(counts[r]||0)+1};
 for(const row of parsed.rows){
   const root=fingerprint(row,0),i=duplicates.get(root)||0;duplicates.set(root,i+1);
   const key=bankKey(fingerprint(row,i));
   if(row.date<bounds.from||row.date>bounds.to){outOfRange++;continue}
   if(existing.has(key)){count('이미 가져온 거래');continue}
   let cls=G.classify(row,state.customRules);
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
   const item={
     id:'bank-'+key,bankKey:key,source:'bank',sourceSheet:'뱅크샐러드',onnuri:false,
     direction:'expense',date:row.date,time:row.time,amount:money(row.amount),
     merchant:row.merchant||'거래처 미기재',payment:row.payment,note:row.memo||'',
     bankMajor:row.major,bankMinor:row.minor,
     scope:cls.scope,ledgerType:cls.ledgerType,category:cls.category,subcategory:cls.subcategory,
     status:cls.status,reason:match.ambiguous?'기존 원장과 날짜·금액 중복 후보 — 직접 확인':cls.reason,
     matchCandidate:!!match.ambiguous,manual:false
   };
   if(match.ambiguous){item.scope='review';item.status='review'}
   if(item.status==='review')reviewCount++;
   all.push(item);
 }
 return {fileName:parsed.fileName,total:parsed.rows.length,range:bounds,outOfRange,newItems:all,links,skips:counts,reviewCount};
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
 if(!confirm(preview.newItems.length+'건을 등록하고 기존 시트의 거래처 '+preview.links.length+'건을 연결할까요? 미분류는 확정 지출로 계산하지 않습니다.'))return;
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
 state.imports.push({at:new Date().toISOString(),name:preview.fileName,rows:preview.total,range:preview.range,outOfRange:preview.outOfRange,added:preview.newItems.length,linked:preview.links.length,review:preview.reviewCount});
 const count=preview.newItems.length;preview=null;
 if(save()){render();navigate('review');toast('거래 '+count+'건을 가져왔습니다. 미분류부터 확인하세요.')}
}
async function importLegacy(file){
 if(!file)return;
 let rows,incomingDaily=[],incomingProfits={};
 try{
   const obj=JSON.parse(await file.text());
   if(obj.version===2&&Array.isArray(obj.records)){
     if(!confirm('가게부 V2 전체 백업 '+obj.records.length+'건을 복원하면 현재 V2 데이터를 교체합니다. 현재 기록을 먼저 JSON으로 백업하셨나요?'))return;
     const previous=state;
     state={...blank(),...obj};
     if(!Array.isArray(state.dailyLotto))state.dailyLotto=[];
     if(!state.storeProfits||typeof state.storeProfits!=='object')state.storeProfits={};
     if(!save()){state=previous;return}
     preview=null;render();toast('V2 전체 백업을 복원했습니다.');return;
   }
   rows=migrateLegacy(obj);
   incomingDaily=Array.isArray(obj.dailyLotto)?obj.dailyLotto:[];
   incomingProfits=obj.storeProfits&&typeof obj.storeProfits==='object'&&!Array.isArray(obj.storeProfits)?obj.storeProfits:{};
 }catch(e){toast('원본 JSON을 읽을 수 없습니다: '+e.message);return}
 const existing=new Set(state.records.map(x=>x.id));
 const keyed=new Map(state.records.filter(x=>x.source==='legacy'&&x.sourceRow!=null&&x.sourceSheet)
   .map(x=>[x.sourceSheet+'|'+x.sourceRow,x]));
 const additions=[],updates=[];let conflicts=0;
 const dailySeen=new Set((state.dailyLotto||[]).map(x=>x.date));
 const dailyNew=[];
 for(const raw of incomingDaily){
   const entry=normalizeDailyLotto(raw);
   if(!entry||dailySeen.has(entry.date))continue;
   dailySeen.add(entry.date);dailyNew.push(entry);
 }
 const profitsNew=Object.entries(incomingProfits).filter(([month,raw])=>
    isMonth(month)&&Number.isSafeInteger(Number(raw))&&state.storeProfits?.[month]===undefined);
 for(const entry of rows){
   const key=entry.sourceSheet+'|'+entry.sourceRow;
   const old=state.records.find(x=>x.id===entry.id)|| (entry.sourceRow==null?null:keyed.get(key));
   if(!old){additions.push(entry);continue}
   if(old.manual)continue;
   if(old.date!==entry.date||old.direction!==entry.direction){
     conflicts++;continue; // a reordered/modified source row must not overwrite a different transaction.
   }
   updates.push({old,entry});
 }
 if(!additions.length&&!updates.length&&!dailyNew.length&&!profitsNew.length){toast('이미 최신 원장입니다. 변경이 필요한 행 '+conflicts+'건은 덮어쓰지 않았습니다.');return}
 if(!confirm('새 거래 '+additions.length+'건, 기존 원장 갱신 '+updates.length+'건, 토토 일별 '+dailyNew.length+'일, 편의점 순이익 '+profitsNew.length+'개월을 복원할까요? 기존 직접 수정·은행 연결 정보는 보존합니다.'+(conflicts?' 의심 행 '+conflicts+'건은 유지합니다.':'')))return;
 for(const {old,entry} of updates){
   old.amount=entry.amount;old.category=entry.category;old.subcategory=entry.subcategory;
   old.payment=entry.payment;old.note=entry.note;old.sourceRow=entry.sourceRow;
   // Retain manually corrected ownership, attached bank merchant and link.
   if(old.status!=='review'){old.scope=entry.scope;old.ledgerType=entry.ledgerType}
 }
 const linkedBankIds=new Set();
 for(const original of additions){
   if(original.direction!=='expense'||(original.category==='발주'&&original.subcategory==='주류'))continue;
   const matching=state.records.filter(b=>b.source==='bank'&&b.direction==='expense'&&!linkedBankIds.has(b.id)&&
     b.amount===original.amount&&b.date===original.date&&b.status!=='excluded');
   if(matching.length!==1)continue;
   const match=matching[0];linkedBankIds.add(match.id);
   original.bankKey=match.bankKey;
   if(!original.merchant)original.merchant=match.merchant;
   original.bankPayment=match.payment;
   if(/온누리/.test(String(original.payment||'')))original.onnuri=true;
   if(((original.category==='집'&&original.subcategory==='월세')||(original.category==='가게'&&original.subcategory==='임대료'))&&match.merchant){
     state.rentRecipients=state.rentRecipients||{};
     state.rentRecipients[G.normalizeMerchant(match.merchant)]={amount:original.amount,scope:original.scope,category:original.category,subcategory:original.subcategory};
   }
   if(match.scope!=='review'&&original.scope!==match.scope){
     original.status='review';original.scope='review';
     original.reason='원본 시트와 뱅크샐러드의 분류가 달라 확인 필요';
   }
 }
 if(linkedBankIds.size)state.records=state.records.filter(x=>!linkedBankIds.has(x.id));
 state.records.push(...additions);
 mergeDailyLotto(dailyNew);
 mergeStoreProfits(Object.fromEntries(profitsNew));
 state.imports.push({at:new Date().toISOString(),name:file.name,added:additions.length,updated:updates.length,dailyAdded:dailyNew.length,profitsAdded:profitsNew.length,linked:linkedBankIds.size,source:'legacy'});
 if(save()){render();toast('원본 신규 '+additions.length+'건 · 토토 일별 '+dailyNew.length+'일 · 편의점 순이익 '+profitsNew.length+'개월 복원')}
}
function download(name,contents,type){
 const url=URL.createObjectURL(new Blob([contents],{type}));
 const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
 setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function exportJSON(){download('가게부_V2_개인백업_'+now()+'.json',JSON.stringify(state,null,2),'application/json;charset=utf-8')}
function exportCSV(){
 const headers=['날짜','시간','거래처','실제 결제수단','뱅샐 등록 카드·원본 결제수단','온누리 사용','금액','사용처','지출종류','대분류','소분류','상태','원본','메모'];
 const rows=state.records.filter(x=>x.direction==='expense').map(x=>[x.date,x.time,x.merchant,paymentLabel(x),x.bankPayment||x.payment||'',isOnnuri(x)?'예':'아니오',x.amount,LABEL[x.scope]||x.scope,GROUP[x.ledgerType]||'',x.category,x.subcategory,x.status,x.sourceSheet||'',x.note]);
 const enc=x=>'"'+String(x??'').replaceAll('"','""')+'"';
 download('가게부_V2_거래내역_'+now()+'.csv','\uFEFF'+[headers,...rows].map(r=>r.map(enc).join(',')).join('\r\n'),'text/csv;charset=utf-8');
}
function editRecord(id){
 const r=id?state.records.find(x=>x.id===id):null;
 editing=id||'new';
 const dlg=$('#editor');
 $('#editor-title').textContent=r?'거래 수정':'거래 직접 입력';
 const f=$('#editor-form');
 f.elements.date.value=r?.date||now();
 f.elements.amount.value=r?.amount??'';
 f.elements.merchant.value=r?.merchant||'';
 f.elements.payment.value=r?.payment||'';
 f.elements.onnuri.checked=r?isOnnuri(r):false;
 const cardHint=$('#editor-registered-card');if(cardHint)cardHint.textContent=r?.bankPayment?'뱅크샐러드 등록 카드: '+r.bankPayment:(r?.payment?'원본 결제수단: '+r.payment:'');
 f.elements.scope.value=r?.scope==='review'?'personal':r?.scope||'personal';
 f.elements.ledgerType.value=r?.ledgerType||'consumption';
 f.elements.category.value=r?.category||'';
 f.elements.subcategory.value=r?.subcategory||'';
 f.elements.note.value=r?.note||'';
 dlg.showModal();
}
function submitEditor(f){
 const data=new FormData(f);const amt=Number(data.get('amount'));
 const merchant=String(data.get('merchant')||'').trim();
 if(!data.get('date')||!(amt>0)||!merchant){toast('날짜·금액·거래처를 입력하세요.');return}
 const scope=String(data.get('scope')),ledgerType=String(data.get('ledgerType')),category=String(data.get('category')||'').trim();
 const entry={date:String(data.get('date')),amount:amt,merchant,payment:String(data.get('payment')||''),onnuri:data.has('onnuri'),note:String(data.get('note')||''),scope,ledgerType,category:category||(scope==='windmoon'?'풍월관':'기타'),subcategory:String(data.get('subcategory')||''),status:scope==='review'?'review':'confirmed',manual:true};
 if(editing&&editing!=='new'){const row=state.records.find(x=>x.id===editing);if(row)Object.assign(row,entry)}
 else state.records.push({...entry,id:'manual-'+uid(),direction:'expense',source:'manual',sourceSheet:'직접 입력',time:'',bankKey:''});
 $('#editor').close();save();render();toast('거래를 저장했습니다.');
}
function onClick(event){
 const target=event.target.closest('button,a,[data-nav]');if(!target)return;
 if(target.dataset.nav){event.preventDefault();navigate(target.dataset.nav);return}
 if(target.dataset.scope){chooseScope(target.dataset.id,target.dataset.scope);return}
 if(target.dataset.edit){editRecord(target.dataset.edit);return}
 if(target.id==='sheet-add-5'||target.id==='sheet-add-20'){
   readSheetCells();const count=target.id==='sheet-add-5'?5:20;
   for(let i=0;i<count&&sheetData.rows.length<sheetData.limit;i++)sheetData.rows.push(sheetNewRow());render();return
 }
 if(target.id==='sheet-remove-empty'){
   readSheetCells();sheetData.rows=sheetData.rows.filter(x=>SHEET_FIELDS.some(f=>!['date','scope','ledgerType'].includes(f)&&String(x[f]||'').trim()));
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
 if(target.id==='mobile-menu'){ $('#sidebar').classList.toggle('open');return}
 if(target.id==='close-sidebar'){ $('#sidebar').classList.remove('open');return}
 if(target.id==='close-editor'){$('#editor').close();return}
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
 if(el.dataset.onnuriId){
   const x=state.records.find(r=>r.id===el.dataset.onnuriId);
   if(!x||x.direction!=='expense')return;
   const was=x.onnuri;x.onnuri=!!el.checked;
   if(!save()){x.onnuri=was;return}
   render();toast(x.onnuri?'온누리상품권 결제로 표시했습니다.':'원본 결제수단 표시로 변경했습니다.');
   return;
 }
 if(el.id==='sheet-default-date'){if(/^\d{4}-\d{2}-\d{2}$/.test(el.value)){
   readSheetCells();const old=sheetData.date;sheetData.date=el.value;
   sheetData.rows.forEach(x=>{if(x.date===old)x.date=sheetData.date});render();
 }return}
 if(el.dataset.sheetField){const row=sheetData.rows[Number(el.dataset.sheetIndex)];if(row){row[el.dataset.sheetField]=el.value;if(el.dataset.sheetField==='scope')row.scopeManual=true;}sheetSelectChange(el);return}
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
 if(el.id==='query-filter'){q=el.value;offset=0;render();$('#query-filter')?.focus();return}
}
function init(){
 load();
 const route=location.hash.replace(/^#/,'');if(VIEWS[route])page=route;
 document.addEventListener('click',onClick);
 document.addEventListener('change',onChange);
 document.addEventListener('input',e=>{
   if(e.target.id==='query-filter')onChange(e);
   if(e.target.dataset?.sheetField){const row=sheetData.rows[Number(e.target.dataset.sheetIndex)];if(row)row[e.target.dataset.sheetField]=e.target.value;}
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
 });
 $('#editor-form').addEventListener('submit',e=>{e.preventDefault();submitEditor(e.target)});
 document.addEventListener('submit',e=>{
   if(e.target.matches('.sales-form')){e.preventDefault();saveMonthlySale(e.target)}
   if(e.target.id==='lotto-daily-form'){e.preventDefault();saveLottoDaily(e.target)}
 });
 document.addEventListener('paste',pasteSheetGrid);
 document.addEventListener('keydown',e=>{
   if(sheetMove(e))return;
   if(e.key==='Escape'){$('#sidebar').classList.remove('open')}
   if(page==='review'&&!$('#editor').open&&!e.altKey&&!e.ctrlKey&&!e.metaKey&&!/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName||'')){
     const row=$('.review-card');const id=row?.dataset.reviewId;
     const mapping={'1':'personal','2':'business','3':'windmoon'};
     if(id&&mapping[e.key]){e.preventDefault();chooseScope(id,mapping[e.key])}
   }
 }, true);
 const drop=$('#content');
 document.addEventListener('dragover',e=>{if(page==='import'&&e.dataTransfer?.types.includes('Files'))e.preventDefault()});
 document.addEventListener('drop',e=>{if(page!=='import'||!e.dataTransfer?.files?.length)return;e.preventDefault();onBankFile(e.dataTransfer.files[0])});
 window.addEventListener('storage',e=>{if(e.key===KEY){try{const x=JSON.parse(e.newValue);if(x.version===2&&Array.isArray(x.records)){state=x;render()}}catch(_){}}});
 render();
}
init();
})();