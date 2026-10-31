/* GAGEBU / Money Desk v2 — local-first, bank-import-driven. Never embeds private transaction data. */
(() => {
'use strict';
const KEY='gagebu-v2-private',OLD='gagebu-v1-data';
const $=(q,root=document)=>root.querySelector(q),$$=(q,root=document)=>Array.from(root.querySelectorAll(q));
const E=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
const n=s=>Number(s)||0,won=v=>Math.round(n(v)).toLocaleString('ko-KR')+'원',ym=()=>new Date().toISOString().slice(0,7);
const now=()=>new Date().toISOString().slice(0,10),uid=()=>crypto.randomUUID();
const G=window.GagebuRules;
const VIEWS={dashboard:'전체 요약',review:'미분류 검토함',records:'전체 거래내역',import:'거래 가져오기',rules:'분류 기준',settings:'데이터 · 설정'};
const LABEL={personal:'개인',business:'편의점',windmoon:'풍월관',review:'미분류',excluded:'제외',transfer:'이체'};
const GROUP={fixed:'고정지출',consumption:'소비지출'};
const SOURCE={bank:'뱅크샐러드',legacy:'구글 시트',manual:'직접 입력'};
const blank=()=>({version:2,records:[],customRules:{},imports:[],excludedAudit:[],createdAt:new Date().toISOString()});
let state=blank(),page='dashboard',period='all',scopeFilter='all',typeFilter='all',q='',offset=0,reviewOffset=0,preview=null,editing=null,toastTimer=null,shownTip=false;
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
  merchant:String(x.merchant||''),payment:String(x.payment||''),note:String(x.note||''),
  source:'legacy',sourceSheet:String(x.sourceSheet||'직접 입력'),sourceId:String(x.id),sourceRow:x.sourceRow??null,
  originalArea:String(x.area||''),status:ledgerScope(x)==='review'?'review':'confirmed',manual:false,bankKey:''
 }));
 return entries.filter(x=>x.date.startsWith('2026-'));
}
function save(){
 try{localStorage.setItem(KEY,JSON.stringify(state));setStatus('이 브라우저에 저장됨');return true}
 catch(err){toast('브라우저 저장 공간 부족: 백업 후 데이터를 확인해 주세요.');return false}
}
function load(){
 try{const existing=JSON.parse(localStorage.getItem(KEY)||'null');
   if(existing&&existing.version===2&&Array.isArray(existing.records)){state={...blank(),...existing};return}
 }catch(err){console.warn('V2 load failed',err)}
 try{const legacy=JSON.parse(localStorage.getItem(OLD)||'null');
   if(legacy&&Array.isArray(legacy.transactions)){
     state.records=migrateLegacy(legacy);state.migratedFromV1=true;save();
   }
 }catch(err){console.warn('Legacy load failed',err)}
}
const relevant=()=>state.records.filter(x=>x.status!=='excluded'&&x.direction==='expense');
const filtered=(list)=>list.filter(x=>(period==='all'||x.date.slice(0,7)===period)&&(scopeFilter==='all'||x.scope===scopeFilter)&&(typeFilter==='all'||x.ledgerType===typeFilter)&&(q===''||[x.merchant,x.category,x.subcategory,x.note,x.payment,x.date].join(' ').toLocaleLowerCase('ko').includes(q.toLocaleLowerCase('ko'))));
const monthlyOptions=()=>{
 const months=new Set(state.records.map(x=>x.date.slice(0,7)).filter(x=>/^20\d\d-\d\d$/.test(x)));
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
 const top=pageIntro('MONEY OVERVIEW','지출을 용도별로, 한눈에','개인 · 편의점 · 풍월관을 분리합니다. 토토 정산과 금융 자산 이동은 가져오기 단계에서 제외합니다.',topFilters());
 return top+
 '<div class="stat-grid">'+statCard('개인 소비',sum(personal),personal.length+'건 · 개인 장부','blue','◉')+
 statCard('편의점 매입 · 운영',sum(business),business.length+'건 · 편의점 장부','teal','▤')+
 statCard('풍월관 관련',sum(windmoon),windmoon.length+'건 · 별도 관리','violet','◈')+
 statCard('미분류 대기',sum(review),review.length+'건 · 판단 전 합계에서 분리','amber','?')+'</div>'+
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
 '<td class="payment-col">'+E(x.payment||'—')+'</td>'+
 '<td>'+scopeBadge(x)+'<small class="cat-text">'+E([x.category,x.subcategory].filter(Boolean).join(' / ')||'미분류')+'</small></td>'+
 '<td class="right amount-col">−'+won(x.amount)+'</td><td><button class="row-edit" data-edit="'+E(x.id)+'">수정</button></td></tr>').join(''):
 '<tr><td colspan="6"><div class="empty">표시할 거래가 없습니다.</div></td></tr>')+'</tbody></table></div>';
}
function reviewCard(x,i){
 const online=x.category==='온라인쇼핑'||/온라인 쇼핑/.test(x.reason||'');
 const suggest=x.matchCandidate?'<span class="match-flag">원장에 유사한 거래가 있습니다 · 중복 확인 필요</span>':'';
 return '<article class="review-card" data-review-id="'+E(x.id)+'"><div class="review-index">'+String(i+1).padStart(2,'0')+'</div><div class="review-main"><div class="review-top"><strong>'+E(x.merchant||'거래처 미기재')+'</strong><span>−'+won(x.amount)+'</span></div>'+
 '<div class="review-metadata">'+E(x.date)+' · '+E(x.payment||'결제수단 미상')+' · '+E([x.bankMajor,x.bankMinor].filter(Boolean).join(' / '))+'</div>'+
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
 '<div class="import-grid"><section class="surface upload-panel"><div class="step"><span>01</span><div><h2>뱅크샐러드 엑셀</h2><p>2026년 1월 이후 자료 분석 · 거래처 원문 보존 · 토토/투자/수입/불필요한 이체 제외</p></div></div>'+
 '<label class="dropzone" id="bank-drop"><input id="bank-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"><span class="drop-icon">⇧</span><strong>뱅크샐러드 XLSX 선택</strong><small>엑셀 파일을 클릭하거나 여기에 끌어다 놓으세요</small></label>'+
 '<div class="import-detail"><span>기존 거래와 날짜·금액·결제수단을 대조해 중복을 줄입니다.</span><span>카드 재발급으로 사라진 거래는 기존 시트에서 보존합니다.</span></div></section>'+
 '<section class="surface upload-panel"><div class="step"><span>02</span><div><h2>기존 가게부 가져오기</h2><p>구글 시트 이관 JSON을 기준 장부로 합칩니다. 예전에 브라우저에 저장한 자료는 자동 복사하며 원본은 유지합니다.</p></div></div>'+
 '<label class="dropzone secondary-drop"><input id="legacy-file" type="file" accept=".json,application/json"><span class="drop-icon">▦</span><strong>가게부 JSON 파일 선택</strong><small>기존 구글 시트 이관 파일 · 데이터 백업 파일</small></label>'+
 '<div class="notice compact"><b>원본 보존</b><p>기존 현금 주류 발주와 오프라인 거래는 뱅크샐러드에 없다고 해서 삭제하지 않습니다.</p></div></section></div>'+
 (preview?importPreview():importEmpty())+
 '<div class="notice"><b>전액을 자동으로 지출 처리하지 않습니다.</b><p>온누리상품권 충전, 카드대금 납부, 주식투자, 토토 운영대금과 고객 송금은 제외합니다. 월세·가게 임대료는 확인된 수취인·금액만 예외 처리합니다.</p></div>';
}
function importEmpty(){return '<section class="surface import-placeholder"><div class="placeholder-icon">◎</div><h2>파일을 선택하면 정리 결과가 표시됩니다</h2><p>신규 거래 / 기존 장부 연결 / 미분류 / 제외 사유를 저장 전에 확인할 수 있습니다.</p></section>'}
function importPreview(){
 const p=preview;
 const summary=Object.entries(p.skips).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>'<div class="summary-line"><span>'+E(k)+'</span><strong>'+v.toLocaleString('ko-KR')+'건</strong></div>').join('');
 return '<section class="surface"><div class="surface-head"><div><h2>가져오기 미리보기</h2><p>'+E(p.fileName)+' · 수집 범위: 2026년 1월 이후</p></div><span class="tag tag-ok">브라우저 내 분석 완료</span></div>'+
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
 container.innerHTML=({dashboard,review:reviewPage,records:recordsPage,import:importPage,rules:rulesPage,settings:settingsPage})[page]();
 $('#sidebar').classList.remove('open');
 setStatus('이 브라우저에 저장됨');
}
function navigate(p){
 if(!VIEWS[p])return;
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
 const eligible=candidates.filter(x=>!used.has(x.id)&&!x.bankKey&&x.amount===money(row.amount)&&dateDiff(x.date,row.date)<=1&&!(x.category==='발주'&&x.subcategory==='주류'));
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
async function processBank(file){
 const parsed=await window.BankSaladXLSX.parseBankSalad(file);
 const existing=new Set(state.records.map(x=>x.bankKey).filter(Boolean));
 const source=state.records.filter(x=>x.source!=='bank'&&x.direction==='expense');
 const used=new Set(),counts={},all=[],links=[];
 const duplicates=new Map();let reviewCount=0;
 const count=r=>{counts[r]=(counts[r]||0)+1};
 for(const row of parsed.rows){
   const root=fingerprint(row,0),i=duplicates.get(root)||0;duplicates.set(root,i+1);
   const key=bankKey(fingerprint(row,i));
   if(existing.has(key)){count('이미 가져온 거래');continue}
   const cls=G.classify(row,state.customRules);
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
     id:'bank-'+key,bankKey:key,source:'bank',sourceSheet:'뱅크샐러드',
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
 return {fileName:parsed.fileName,total:parsed.rows.length,newItems:all,links,skips:counts,reviewCount};
}
async function onBankFile(file){
 if(!file)return;
 try{
  $('#save-indicator').textContent='금융내역 분석 중…';
  preview=await processBank(file);
  render();
  toast('분석 완료: '+preview.newItems.length+'건 신규 후보, '+preview.reviewCount+'건 검토 필요');
 }catch(e){console.error(e);toast('엑셀 분석 오류: '+e.message);setStatus('가져오기 실패')}
}
function commitBank(){
 if(!preview)return;
 if(!confirm(preview.newItems.length+'건을 등록하고 기존 시트의 거래처 '+preview.links.length+'건을 연결할까요? 미분류는 확정 지출로 계산하지 않습니다.'))return;
 const map=new Map(state.records.map(x=>[x.id,x]));
 for(const link of preview.links){
   const x=map.get(link.id);if(!x)continue;
   x.bankKey=link.bankKey;
   if(!x.merchant)x.merchant=link.merchant||'';
   if(!x.bankPayment)x.bankPayment=link.payment||'';
   if(link.reviewConflict){x.scope='review';x.status='review';x.reason='기존 시트 분류와 금융 거래의 지역 규칙이 달라 확인 필요'}
 }
 state.records.push(...preview.newItems);
 state.imports.push({at:new Date().toISOString(),name:preview.fileName,rows:preview.total,added:preview.newItems.length,linked:preview.links.length,review:preview.reviewCount});
 const count=preview.newItems.length;preview=null;
 if(save()){render();navigate('review');toast('거래 '+count+'건을 가져왔습니다. 미분류부터 확인하세요.')}
}
async function importLegacy(file){
 if(!file)return;
 let rows;
 try{const obj=JSON.parse(await file.text());rows=migrateLegacy(obj)}
 catch(e){toast('원본 JSON을 읽을 수 없습니다: '+e.message);return}
 const existing=new Set(state.records.map(x=>x.id));
 const keyed=new Map(state.records.filter(x=>x.source==='legacy'&&x.sourceRow!=null&&x.sourceSheet)
   .map(x=>[x.sourceSheet+'|'+x.sourceRow,x]));
 const additions=[],updates=[];let conflicts=0;
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
 if(!additions.length&&!updates.length){toast('이미 최신 원장입니다. 변경이 필요한 행 '+conflicts+'건은 덮어쓰지 않았습니다.');return}
 if(!confirm('새 거래 '+additions.length+'건을 추가하고 기존 원장 '+updates.length+'건의 시트 정보를 갱신할까요? 은행 결제와 연결된 거래처·결제정보는 보존합니다.'+(conflicts?' 원본 위치가 바뀐 의심 행 '+conflicts+'건은 유지합니다.':'')))return;
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
   if(match.scope!=='review'&&original.scope!==match.scope){
     original.status='review';original.scope='review';
     original.reason='원본 시트와 뱅크샐러드의 분류가 달라 확인 필요';
   }
 }
 if(linkedBankIds.size)state.records=state.records.filter(x=>!linkedBankIds.has(x.id));
 state.records.push(...additions);
 state.imports.push({at:new Date().toISOString(),name:file.name,added:additions.length,updated:updates.length,linked:linkedBankIds.size,source:'legacy'});
 if(save()){render();toast('원본 신규 '+additions.length+'건 · 기존 갱신 '+updates.length+'건 · 은행 연결 '+linkedBankIds.size+'건')}
}
function download(name,contents,type){
 const url=URL.createObjectURL(new Blob([contents],{type}));
 const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
 setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function exportJSON(){download('가게부_V2_개인백업_'+now()+'.json',JSON.stringify(state,null,2),'application/json;charset=utf-8')}
function exportCSV(){
 const headers=['날짜','시간','거래처','결제수단','금액','사용처','지출종류','대분류','소분류','상태','원본','메모'];
 const rows=state.records.filter(x=>x.direction==='expense').map(x=>[x.date,x.time,x.merchant,x.payment,x.amount,LABEL[x.scope]||x.scope,GROUP[x.ledgerType]||'',x.category,x.subcategory,x.status,x.sourceSheet||'',x.note]);
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
 const entry={date:String(data.get('date')),amount:amt,merchant,payment:String(data.get('payment')||''),note:String(data.get('note')||''),scope,ledgerType,category:category||(scope==='windmoon'?'풍월관':'기타'),subcategory:String(data.get('subcategory')||''),status:'confirmed',manual:true};
 if(editing&&editing!=='new'){const row=state.records.find(x=>x.id===editing);if(row)Object.assign(row,entry)}
 else state.records.push({...entry,id:'manual-'+uid(),direction:'expense',source:'manual',sourceSheet:'직접 입력',time:'',bankKey:''});
 $('#editor').close();save();render();toast('거래를 저장했습니다.');
}
function onClick(event){
 const target=event.target.closest('button,a,[data-nav]');if(!target)return;
 if(target.dataset.nav){event.preventDefault();navigate(target.dataset.nav);return}
 if(target.dataset.scope){chooseScope(target.dataset.id,target.dataset.scope);return}
 if(target.dataset.edit){editRecord(target.dataset.edit);return}
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
 document.addEventListener('input',e=>{if(e.target.id==='query-filter')onChange(e)});
 $('#editor-form').addEventListener('submit',e=>{e.preventDefault();submitEditor(e.target)});
 document.addEventListener('keydown',e=>{
   if(e.key==='Escape'){$('#sidebar').classList.remove('open')}
   if(page==='review'&&!$('#editor').open&&!e.altKey&&!e.ctrlKey&&!e.metaKey&&!/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName||'')){
     const row=$('.review-card');const id=row?.dataset.reviewId;
     const mapping={'1':'personal','2':'business','3':'windmoon'};
     if(id&&mapping[e.key]){e.preventDefault();chooseScope(id,mapping[e.key])}
   }
 });
 const drop=$('#content');
 document.addEventListener('dragover',e=>{if(page==='import'&&e.dataTransfer?.types.includes('Files'))e.preventDefault()});
 document.addEventListener('drop',e=>{if(page!=='import'||!e.dataTransfer?.files?.length)return;e.preventDefault();onBankFile(e.dataTransfer.files[0])});
 window.addEventListener('storage',e=>{if(e.key===KEY){try{const x=JSON.parse(e.newValue);if(x.version===2&&Array.isArray(x.records)){state=x;render()}}catch(_){}}});
 render();
}
init();
})();