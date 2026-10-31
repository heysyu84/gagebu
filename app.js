/* 가게부 / 2026.10 / 공개 코드에는 개인 재무 데이터가 포함되지 않습니다. */
(() => {
  'use strict';
  const KEY = 'gagebu-v1-data';
  const NAV = {dashboard:'대시보드',transactions:'거래내역',quick:'개별 입력',sheet:'시트형 일괄 입력',lotto:'토토 매출상세',analysis:'지출 분석',recurring:'반복 지출',data:'데이터 관리'};
  const empty = () => ({schema:'store-ledger-v1',transactions:[],dailyLotto:[],sourceTitle:'',exportedAt:''});
  const ymd = (date=new Date()) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  const pad = n => String(n).padStart(2,'0');
  const fmt = n => (Number(n)||0).toLocaleString('ko-KR');
  const won = n => `${fmt(n)}원`;
  const shortWon = n => {const x=Math.abs(Number(n)||0);const sign=n<0?'-':'';return x>=100000000?sign+(x/100000000).toFixed(2)+'억':x>=1000000?sign+(x/10000).toFixed(0)+'만':fmt(n)};
  const esc = s => String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const val = s => Number(String(s??'').replace(/[^0-9.-]/g,''))||0;
  const monthOf = x => String(x?.date||'').slice(0,7);
  // 기존 브라우저/백업의 대납 분류를 일반 개인 소비로 전환합니다.
  // 원본 쇼핑 3건은 날짜·금액·메모·결제수단 그대로 유지합니다.
  const upgrade = data => {
    let changed=false;
    const sourceIds=new Set(['sp-541','sp-597','sp-611']);
    for(const x of data.transactions||[]){
      if(sourceIds.has(x.id) && x.category==='쇼핑' && x.note==='풍월관'
        && ['expense','advance'].includes(x.kind)){
        if(x.kind!=='expense'||x.area!=='personal'){x.kind='expense';x.area='personal';changed=true}
      }
      if(x.kind==='advance'){
        x.kind='expense';if(x.area==='receivable')x.area='personal';changed=true;
      } else if(x.kind==='repayment'){
        x.kind='income';if(x.area==='receivable')x.area='personal';changed=true;
      } else if(x.area==='receivable') {x.area='personal';changed=true}
      if('counterparty' in x){delete x.counterparty;changed=true}
    }
    return changed;
  };
  const labelArea = x => ({business:'편의점',personal:'개인',review:'확인 필요',transfer:'저축/이체'})[x]||'미지정';
  const labelKind = x => ({income:'수입',expense:'지출',transfer:'이체'})[x]||x;

  // Original '고정지출' is a ledger source, not necessarily a recurring cost.
  const FIXED_LEDGER_CATS=new Set(['담배 발주','발주','가게','집','보험','건보/연금','세금','저축','월정액']);
  const inferExpenseGroup=cat=>FIXED_LEDGER_CATS.has(String(cat||'').trim())?'fixed':'consumption';
  const expenseGroupOf=x=>{
    if(x.kind!=='expense')return '';
    if(x.expenseGroup==='fixed'||x.expenseGroup==='consumption')return x.expenseGroup;
    if(x.sourceSheet==='고정지출')return 'fixed';
    if(x.sourceSheet==='소비지출')return 'consumption';
    return inferExpenseGroup(x.category);
  };
  const labelExpenseGroup=x=>expenseGroupOf(x)==='fixed'?'고정지출':expenseGroupOf(x)==='consumption'?'소비지출':'—';
  const groupControl=(value,kind)=>'<div class="form-group" id="tx-expense-group-wrap"'+(kind==='expense'?'':' hidden')+'><label for="tx-expense-group">지출 종류</label><select id="tx-expense-group" name="expenseGroup">'+[['fixed','고정지출'],['consumption','소비지출']].map(([v,n])=>'<option value="'+v+'"'+(v===value?' selected':'')+'>'+n+'</option>').join('')+'</select></div>';
  const amountText = x => (x.kind==='income'?'+':x.kind==='expense'?'-':'↗') + fmt(x.amount);
  const sum = (arr,fn=x=>x.amount) => arr.reduce((a,b)=>a+(Number(fn(b))||0),0);
  let db=empty(),page='dashboard',period='all',filters={query:'',area:'all',kind:'all',expenseGroup:'all',category:'all'},ledgerOffset=0,editId=null,lottoOffset=0;
  let noticeTimer=null;let searchTimer=null;
  let lastView='dashboard';
  let sheetKind='expense',sheetDate=ymd(),lottoEntryMonth=ymd().slice(0,7);
  try {const s=localStorage.getItem(KEY); if(s){const parsed=JSON.parse(s);if(Array.isArray(parsed.transactions))db={...empty(),...parsed};}} catch(e){console.warn('보관 자료 복구 실패',e)}
  if(!db.transactions.length && window.__INITIAL_LEDGER__?.schema==='store-ledger-v1')db=window.__INITIAL_LEDGER__;
  if(upgrade(db)||db.transactions.length){try{localStorage.setItem(KEY,JSON.stringify(db))}catch(e){console.warn(e)}}
  // Cloudflare D1 backing store. No API password or ledger JSON is embedded in GitHub Pages.
  const API_CONFIG='store-ledger-private-api-url',SESSION='store-ledger-private-session',PENDING='store-ledger-sync-pending';
  let apiBase=localStorage.getItem(API_CONFIG)||'',apiToken=sessionStorage.getItem(SESSION)||'',serverVersion=null;
  let connected=false,syncInFlight=false,syncQueued=false,syncBlocked=false,loadingRemote=false,awaitingInitialUpload=false;
  const setSyncLabel=msg=>{const tag=document.querySelector('.local-badge');if(tag)tag.innerHTML=`<span class="privacy-dot"></span> ${esc(msg)}`;};
  const apiCall=async(path,options={})=>{
    if(!apiBase)throw Error('서버 주소 미설정');
    const headers={'Content-Type':'application/json',...(apiToken?{'Authorization':`Bearer ${apiToken}`}:{})};
    const res=await fetch(apiBase+path,{method:options.method||'GET',headers,cache:'no-store',...(options.body?{body:JSON.stringify(options.body)}:{})});
    let out={};try{out=await res.json()}catch{}
    if(!res.ok){const error=Error(out.error||`HTTP ${res.status}`);error.status=res.status;throw error}
    return out;
  };
  const uploadServer=async()=>{
    if(!connected||serverVersion===null){toast('먼저 서버에 로그인해 주세요.');return}
    if(syncInFlight){syncQueued=true;return}
    if(syncBlocked){toast('서버에 다른 변경이 있습니다. 백업한 뒤 서버 자료를 다시 불러와 주세요.');return}
    syncInFlight=true;setSyncLabel('서버에 저장 중…');
    try{
      const snapshot=JSON.parse(JSON.stringify(db));
      const result=await apiCall('/api/state',{method:'PUT',body:{version:serverVersion,data:snapshot}});
      serverVersion=result.version;awaitingInitialUpload=false;localStorage.removeItem(PENDING);setSyncLabel('서버 저장됨');
    }catch(err){
      syncBlocked=err.status===409||err.status===401;
      localStorage.setItem(PENDING,'1');setSyncLabel(syncBlocked?'저장 충돌 · 확인 필요':'서버 저장 오류');
      toast(syncBlocked?'다른 기기에서 장부가 변경됐습니다. 데이터 관리에서 백업 후 서버 기록을 확인하세요.':'서버 저장 실패: 로컬 기록을 보존했습니다. 데이터 관리에서 다시 저장하세요.');
    }finally{
      syncInFlight=false;
      if(syncQueued&&!syncBlocked){syncQueued=false;uploadServer()}
    }
  };
  const save=()=>{
    try{
      localStorage.setItem(KEY,JSON.stringify(db));
      if(apiBase&&!loadingRemote){localStorage.setItem(PENDING,'1');if(connected){if(syncInFlight)syncQueued=true;else void uploadServer()}}
      return true;
    }catch(e){toast('저장 실패 · 브라우저 저장 공간을 확인하세요');return false}
  };
  const pullServer=async(initial=false)=>{
    if(!apiToken||!apiBase)return;
    setSyncLabel('서버 동기화 확인 중…');
    try{
      const result=await apiCall('/api/state');serverVersion=result.version;connected=true;syncBlocked=false;
      const remote=result.data;
      if(!remote||!Array.isArray(remote.transactions))throw Error('서버 자료 형식 오류');
      if(localStorage.getItem(PENDING)==='1'&&db.transactions.length){
        syncBlocked=true;setSyncLabel('미동기화 자료 확인 필요');
        toast('이 브라우저에 아직 서버에 저장되지 않은 자료가 있습니다. 먼저 JSON 백업하고 서버와 비교하세요.');
        return;
      }
      if(remote.transactions.length===0&&remote.dailyLotto.length===0&&db.transactions.length){
        awaitingInitialUpload=true;setSyncLabel('서버 비어 있음 · 업로드 필요');
        toast('서버가 비어 있습니다. 데이터 관리에서 기존 장부를 서버에 최초 등록할 수 있습니다.');return;
      }
      awaitingInitialUpload=false;loadingRemote=true;db={...empty(),...remote};upgrade(db);
      localStorage.setItem(KEY,JSON.stringify(db));loadingRemote=false;
      setSyncLabel('서버 저장 연결됨');render();
      if(!initial)toast('서버에 저장된 최신 장부를 불러왔습니다.');
    }catch(err){loadingRemote=false;connected=false;syncBlocked=true;setSyncLabel('서버 연결 오류');
      if(err.status===401){apiToken='';sessionStorage.removeItem(SESSION)}
      toast(`서버 연결 실패: ${err.message}`)
    }
  };
  const serverSettings=()=>card('서버 저장 · 기기 간 동기화','Cloudflare Worker/D1 배포 후 연결합니다. 서버가 연결되기 전에는 기존처럼 이 브라우저에만 기록됩니다.',
    `<form id="server-login-form" class="server-connect"><label>개인 API 주소<input name="apiBase" placeholder="https://store-ledger-private-api.계정.workers.dev" value="${esc(apiBase)}" autocomplete="url" required></label><label>관리자 비밀번호<input name="password" type="password" placeholder="Cloudflare에 설정한 비밀번호" autocomplete="current-password" ${connected?'':'required'}></label><button type="submit" class="btn btn-primary">${connected?'다시 로그인':'서버 연결'}</button></form><div class="small-muted mt-10">상태: <b>${!apiBase?'서버 미설정':connected?(syncBlocked?'동기화 충돌 / 확인 필요':awaitingInitialUpload?'서버 비어 있음 · 최초 업로드 필요':`연결됨 · 버전 ${serverVersion??'—'}`):'로그인 필요 또는 연결 끊김'}</b> · 인증 토큰은 이 탭에서만 보관하며 비밀번호는 저장하지 않습니다.</div><div class="form-actions"><button class="btn btn-small" id="server-pull" ${!connected?'disabled':''}>서버 최신 기록 불러오기</button><button class="btn btn-small" id="server-push" ${!connected?'disabled':''}>현재 장부를 서버에 저장</button><button class="btn btn-small" id="server-logout" ${!apiToken?'disabled':''}>서버 로그아웃</button></div><p class="small-muted mt-10">최초 업로드는 서버가 비어 있을 때만 권장합니다. 여러 기기에서 수정한 데이터가 겹치면 자동 덮어쓰지 않습니다. 서버 연결 전에는 로컬 JSON 백업을 보관하세요.</p>`);
  const loginServer=async form=>{
    const data=new FormData(form),address=String(data.get('apiBase')||'').trim().replace(/\/$/,'');
    if(!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(address)){toast('HTTPS 서버 주소를 확인해 주세요.');return}
    apiBase=address;localStorage.setItem(API_CONFIG,apiBase);
    try{
      const ret=await apiCall('/api/login',{method:'POST',body:{password:String(data.get('password')||'')}});
      apiToken=ret.token;sessionStorage.setItem(SESSION,apiToken);syncBlocked=false;
      await pullServer();render();
    }catch(err){toast('서버 로그인 실패: '+err.message)}
  };

  const toast=msg=>{const el=document.querySelector('#toast');el.textContent=msg;el.classList.add('visible');clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>el.classList.remove('visible'),3200)};
  const years=[...new Set([...db.transactions.map(x=>monthOf(x)),...db.dailyLotto.map(x=>monthOf(x))].filter(x=>/^\d{4}-\d{2}$/.test(x)))].sort();
  const availableMonths=()=>[...new Set(['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08','2026-09','2026-10',...db.transactions.map(monthOf),...db.dailyLotto.map(monthOf)])].sort();
  const periodOptions=()=>`<option value="all" ${period==='all'?'selected':''}>2026년 전체</option>${availableMonths().map(m=>`<option value="${esc(m)}" ${period===m?'selected':''}>${m.slice(0,4)}년 ${Number(m.slice(5))}월</option>`).join('')}`;
  const periodSelect=()=>`<select id="period-select" class="select" aria-label="조회 월 선택">${periodOptions()}</select>`;
  const current=()=>db.transactions.filter(t=>period==='all'||monthOf(t)===period);
  const exp=t=>t.kind==='expense';
  const inc=t=>t.kind==='income';
  const trans=t=>t.kind==='transfer';
  const stat=t=>({income:sum(t.filter(inc)),expense:sum(t.filter(exp)),transfer:sum(t.filter(trans)),businessIncome:sum(t.filter(x=>inc(x)&&x.area==='business')),businessExpense:sum(t.filter(x=>exp(x)&&x.area==='business')),personalExpense:sum(t.filter(x=>exp(x)&&x.area==='personal')),unclassified:sum(t.filter(x=>exp(x)&&x.area==='review'))});
  const sourceBanner=()=>db.transactions.length?'':`<div class="banner warning"><div><strong>아직 이 브라우저에 장부가 없습니다.</strong> 제공된 ‘가계부2026_이관데이터.json’ 파일을 가져오면 기존 기록이 복원됩니다.</div><button class="btn btn-primary" data-page="data">이관 파일 가져오기</button></div>`;
  const intro=(small,title,subtitle,controls='')=>`<section class="page-intro"><div><div class="eyebrow">${small}</div><h1>${title}</h1><p>${subtitle}</p></div>${controls?`<div class="page-controls">${controls}</div>`:''}</section>`;
  const card=(title,sub,html,extra='')=>`<section class="panel"><header class="panel-head"><div><h2>${title}</h2><p>${sub||''}</p></div>${extra}</header><div class="panel-body">${html}</div></section>`;
  const tag=(area,kind)=>`<span class="chip ${esc(area)}">${labelArea(area)}</span>${kind?` <span class="chip ${esc(kind)}">${labelKind(kind)}</span>`:''}`;
  const isIncomeConfirmed=(t)=>t.kind==='income';
  const monthOverview=()=>availableMonths().filter(m=>m.startsWith('2026-')).map(m=>({m,...stat(db.transactions.filter(t=>monthOf(t)===m)),lotto:sum(db.dailyLotto.filter(x=>monthOf(x)===m),x=>x.commission)}));
  const previewCommission=()=>sum(db.dailyLotto.filter(x=>period==='all'?x.date.startsWith('2026-10'):monthOf(x)===period),x=>x.commission);
  const chart=(rows,mode='all')=>{
    const visible=rows.filter(x=>mode==='all'||(x.income+x.expense)>0);if(!visible.length)return '<div class="empty">차트 자료가 없습니다.</div>';
    const max=Math.max(...visible.flatMap(x=>[x.income,x.expense]),1);const h=207,w=740,l=63,r=18,t=18,b=37;const chartW=w-l-r,chartH=h-t-b;
    const lines=[0,.25,.5,.75,1].map(v=>`<line x1="${l}" y1="${t+(1-v)*chartH}" x2="${w-r}" y2="${t+(1-v)*chartH}" stroke="#edf1f4"/><text x="${l-11}" y="${t+(1-v)*chartH+4}" fill="#a8b2bb" font-size="10" text-anchor="end">${esc(shortWon(max*v))}</text>`).join('');
    const step=chartW/visible.length,bw=Math.min(step*.28,22);
    const bars=visible.map((x,i)=>{const xc=l+i*step+step/2;return `<rect x="${xc-bw-2}" y="${t+chartH-x.income/max*chartH}" width="${bw}" height="${x.income/max*chartH}" rx="4" fill="#209b88"><title>${x.m} 수입 ${fmt(x.income)}원</title></rect><rect x="${xc+2}" y="${t+chartH-x.expense/max*chartH}" width="${bw}" height="${x.expense/max*chartH}" rx="4" fill="#e6a1a8"><title>${x.m} 지출 ${fmt(x.expense)}원</title></rect><text x="${xc}" y="${h-13}" text-anchor="middle" fill="#8b9aa7" font-size="10">${Number(x.m.slice(5))}월</text>`}).join('');
    return `<div class="legend"><span><i style="background:#209b88"></i>확정 수입</span><span><i style="background:#e6a1a8"></i>사업·개인 지출 (저축·이체 제외)</span></div><svg class="chart-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="월별 수입과 지출 막대그래프">${lines}${bars}</svg>`;
  };
  const fmtSigned=n=>`<span class="${n<0?'neg':'pos'}">${n<0?'−':'+'}${won(Math.abs(n))}</span>`;
  const kpi=(title,n,foot,icon,negative=false)=>`<div class="stat"><div class="stat-label">${title}<span class="stat-icon">${icon}</span></div><div class="stat-value ${n<0||negative?'neg':''}">${won(n)}</div><div class="stat-foot">${foot}</div></div>`;
  const ledgerRows=(rows,compact=false)=>rows.map(x=>`<tr><td>${esc(x.date)}</td><td>${tag(x.area,x.kind)}</td>${compact?'':`<td><span class="chip">${esc(labelExpenseGroup(x))}</span></td>`}<td>${esc(x.category)}${x.subcategory?` <small class="small-muted">/ ${esc(x.subcategory)}</small>`:''}</td>${compact?'':`<td>${esc(x.payment||'—')}</td>`}<td class="memo" title="${esc(x.note)}">${esc(x.note||'—')}</td><td class="amount ${x.kind==='income'?'pos':''}">${amountText(x)}</td>${compact?'':`<td class="right"><div class="row-actions"><button class="btn-plain" data-edit="${esc(x.id)}" title="수정">수정</button><button class="btn-plain" data-delete="${esc(x.id)}" title="삭제">삭제</button></div></td>`}</tr>`).join('');
  const basicTable=(items,compact=false)=>`<div class="data-table-wrap"><table class="data-table"><thead><tr><th>날짜</th><th>구분</th>${compact?'':'<th>지출 종류</th>'}<th>분류</th>${compact?'':'<th>결제 수단</th>'}<th>메모</th><th style="text-align:right">금액</th>${compact?'':'<th style="text-align:right">관리</th>'}</tr></thead><tbody>${items.length?ledgerRows(items,compact):`<tr><td colspan="${compact?5:8}" class="empty">표시할 내역이 없습니다.</td></tr>`}</tbody></table></div>`;
  const sorted=(items)=>[...items].sort((a,b)=>b.date.localeCompare(a.date)||String(b.id).localeCompare(String(a.id)));
  const dashboard=()=>{
    const t=current(),s=stat(t),rows=monthOverview();const biggest=Object.entries(t.filter(exp).reduce((a,x)=>{a[x.category]=(a[x.category]||0)+x.amount;return a},{})).sort((a,b)=>b[1]-a[1]).slice(0,6);const cap=Math.max(...biggest.map(x=>x[1]),1);
    const review=db.transactions.filter(x=>x.area==='review'&&(period==='all'||monthOf(x)===period));
    const top=`${intro('FINANCIAL OVERVIEW','돈의 흐름을 한눈에','사업 지출 · 개인 소비 · 저축 이체를 분리해 실제 흐름을 확인합니다.',periodSelect()+`<button class="btn btn-soft" data-page="quick">＋ 빠른 입력</button>`)}`;
    return top+sourceBanner()+`${period==='2026-10'&&previewCommission()?`<div class="banner warning"><div><strong>10월 토토 수수료 일별 잠정 합계 ${won(previewCommission())}</strong> · 월 수입 확정 전이므로 위 수입과 순현금흐름에 포함하지 않았습니다.</div><button class="btn" data-page="lotto">일별 확인</button></div>`:''}`+
    `<div class="stat-grid">${kpi('확정 수입',s.income,'가게 매출 + 토토 확정 수수료','↗')}${kpi('사업·개인 지출',s.expense,'저축·이체 제외','↙')}${kpi('장부 수지',s.income-s.expense,'수입 − 지출','≋')}${kpi('편의점 사업수지',s.businessIncome-s.businessExpense,'매출 − 편의점 지출','▣')}</div>`+
    `<div class="grid-two">${card('월별 수입 · 지출','확정 매출 중심 · 현금 및 카드 지출은 사용 시점 기준',chart(rows))}${card('돈은 어디에 썼을까','선택 기간 대분류별 지출 상위 6개',biggest.length?biggest.map(([c,v],i)=>`<div class="progress-item"><div class="progress-top"><span>${esc(c)}</span><b>${won(v)}</b></div><div class="progress-bar"><i style="width:${(v/cap*100).toFixed(2)}%;background:${['#149683','#79b3a5','#84a8c4','#adb5d1','#c6b0b0','#c9cfcf'][i]}"></i></div></div>`).join(''):'<div class="empty">지출 데이터가 없습니다.</div>')}</div>`+
    `<div class="grid-two">${card('사업·생활비 분리','편의점 사업수지는 매입·운영비 지급 기준이며 재고 변동과 카드 미결제액을 반영한 회계상 순이익은 아닙니다.',`<div class="metric-line"><span>편의점 관련 수입</span><strong>${won(s.businessIncome)}</strong></div><div class="metric-line"><span>편의점 매입·운영·사업비</span><strong>−${won(s.businessExpense)}</strong></div><div class="metric-line"><strong>편의점 장부 기준 사업수지</strong><strong>${fmtSigned(s.businessIncome-s.businessExpense)}</strong></div><hr style="border:0;border-top:1px solid #edf1f3;margin:14px 0"><div class="metric-line"><span>개인 생활비·보험 등</span><strong>−${won(s.personalExpense)}</strong></div><div class="metric-line"><span>분류 확인이 필요한 지출</span><strong>${won(s.unclassified)}</strong></div><div class="metric-line"><span>저축·계좌이체 (손익 제외)</span><strong>${won(s.transfer)}</strong></div>`)}${card('최근 거래','최근 등록 및 과거 이관 내역',sorted(t).slice(0,6).map(x=>`<div class="list-row"><div class="list-group"><span class="swatch" style="background:${x.kind==='income'?'#139d86':x.kind==='transfer'?'#9a86c5':'#e89b9f'}"></span><div><strong>${esc(x.category)}</strong> ${x.subcategory?`<small>/ ${esc(x.subcategory)}</small>`:''}<small style="display:block">${esc(x.date)} · ${labelArea(x.area)}</small></div></div><strong class="${x.kind==='income'?'pos':''}">${amountText(x)}원</strong></div>`).join('')||'<div class="empty">거래내역이 없습니다.</div>','<button class="btn-plain" data-page="transactions">전체 보기</button>')}</div>`+
    (review.length?`<div class="banner warning"><div><strong>분류 확인 필요 ${review.length}건 · ${won(sum(review))}</strong><br>세금 성격이 불분명한 항목입니다. 편의점 경비나 개인 지출로 임의 분류하지 않았습니다.</div><button class="btn" data-page="data">검토하기</button></div>`:'')+
    `<div class="footer-note">※ 확정 수입은 월별 수입 시트 기준. 토토 일별 명세는 참고용으로 별도 보관하고 중복 합산하지 않습니다. 결제금액 기준 장부이므로 계좌 실잔고와 일치하는 장부는 아닙니다.</div>`;
  };
  const transactions=()=>{
    let rows=current();if(filters.area!=='all')rows=rows.filter(x=>x.area===filters.area);if(filters.kind!=='all')rows=rows.filter(x=>x.kind===filters.kind);if(filters.expenseGroup!=='all')rows=rows.filter(x=>expenseGroupOf(x)===filters.expenseGroup);if(filters.category!=='all')rows=rows.filter(x=>x.category===filters.category);
    if(filters.query){const q=filters.query.toLocaleLowerCase();rows=rows.filter(x=>[x.date,x.category,x.subcategory,x.payment,x.note].some(y=>String(y||'').toLocaleLowerCase().includes(q)))}
    rows=sorted(rows);const shown=rows.slice(ledgerOffset,ledgerOffset+80);
    const cats=[...new Set(db.transactions.map(x=>x.category))].filter(Boolean).sort((a,b)=>a.localeCompare(b,'ko'));
    return intro('TRANSACTIONS','거래내역','기존 1,072건의 원본 출처를 보존하면서 새로운 거래를 추가·수정할 수 있습니다.',periodSelect()+`<button class="btn btn-soft" id="csv-export">↓ CSV 추출</button>`)+sourceBanner()+`<section class="panel"><div class="table-tools"><input id="f-query" class="search" value="${esc(filters.query)}" placeholder="메모·분류·결제수단 검색"><div class="page-controls"><select id="f-area" class="select"><option value="all">모든 구분</option>${['business','personal','review','transfer'].map(a=>`<option value="${a}" ${filters.area===a?'selected':''}>${labelArea(a)}</option>`).join('')}</select><select id="f-kind" class="select">${[['all','모든 유형'],['income','수입'],['expense','지출'],['transfer','이체']].map(([v,s])=>`<option value="${v}" ${filters.kind===v?'selected':''}>${s}</option>`).join('')}</select><select id="f-expense-group" class="select"><option value="all">모든 지출 종류</option><option value="fixed" ${filters.expenseGroup==='fixed'?'selected':''}>고정지출</option><option value="consumption" ${filters.expenseGroup==='consumption'?'selected':''}>소비지출</option></select><select id="f-category" class="select"><option value="all">전체 분류</option>${cats.map(c=>`<option ${filters.category===c?'selected':''}>${esc(c)}</option>`).join('')}</select></div></div><div class="split-summary"><div><span class="split-label">검색 거래</span><strong>${fmt(rows.length)}건</strong></div><div><span class="split-label">검색 지출</span><strong>${won(sum(rows.filter(exp)))}</strong></div><div><span class="split-label">검색 수입</span><strong>${won(sum(rows.filter(inc)))}</strong></div></div>${basicTable(shown)}<div class="pager"><span>${rows.length?ledgerOffset+1:0}–${Math.min(rows.length,ledgerOffset+80)} / ${rows.length}건</span><button class="btn btn-small" data-offset="prev" ${!ledgerOffset?'disabled':''}>이전</button><button class="btn btn-small" data-offset="next" ${ledgerOffset+80>=rows.length?'disabled':''}>다음</button></div></section>`;
  };
  const allCats=()=>[...new Set([...db.transactions.map(x=>x.category),...['가게 매출','토토 수수료','담배 발주','발주','가게','세금','집','보험','건보/연금','저축','식재료','편의점','외식/배달','병원/약국','쇼핑','여행','교통비','기타']])].filter(Boolean).sort((a,b)=>a.localeCompare(b,'ko'));
  const BASE_SUBS = {
    '담배 발주':['KT&G','던힐','말보로','메비우스'],
    '발주':['상온','주류','쿠팡','네이버','지마켓','미스터파크','기타'],
    '가게':['임대료','전기료','통신료','보안업체','스포츠 토토','가맹비','점소모품','기타'],
    '집':['월세','전기료','통신료','수도세','가스요금','기타'],
    '건보/연금':['건강보험','국민연금','기타'],
    '세금':['부가가치세','종합소득세','지방세','세무사 기장료','기타'],
    '보험':['삼성화재','메리츠','KB암보험','KB주가지수','KB7년의약속','기타'],
    '저축':['주택청약','적금','저금'],
    '월정액':['11번가','쿠팡','네이버','지마켓','기타'],
    '기타':['카드연회비','기타']
  };
  const subcategories = cat => [...new Set([...(BASE_SUBS[cat]||[]),...db.transactions.filter(x=>x.category===cat).map(x=>x.subcategory).filter(Boolean)])].sort((a,b)=>a.localeCompare(b,'ko'));
  const subChoices=(cat,selected='')=>{
    const choices=subcategories(cat);
    if(selected && !choices.includes(selected))choices.push(selected);
    return `<option value="">선택 안 함</option>${choices.map(x=>`<option value="${esc(x)}" ${x===selected?'selected':''}>${esc(x)}</option>`).join('')}<option value="__custom__">＋ 직접 입력</option>`;
  };
  const refreshSub=(selected='')=>{
    const cat=document.querySelector('#tx-cat')?.value||'';
    const select=document.querySelector('#tx-sub');if(!select)return;
    select.innerHTML=subChoices(cat,selected);select.value=selected||'';
    const custom=document.querySelector('#tx-sub-custom');
    if(custom){custom.hidden=true;custom.value='';}
  };
  const allPays=()=>[...new Set([...db.transactions.map(x=>x.payment),...['신용카드','현금/송금','자동이체','신한HI-POINT','신한클래식Y','쿠팡국민카드','온누리상품권']])].filter(Boolean).sort((a,b)=>a.localeCompare(b,'ko'));
  const quick=()=>{
    const item=db.transactions.find(x=>x.id===editId);
    const date=item?.date||ymd();let kind=item?.kind||'expense';let area=item?.area||'personal';const expenseGroup=item?expenseGroupOf(item):'consumption';
    const recents=sorted(db.transactions.filter(x=>x.kind==='expense')).filter((x,i,a)=>a.findIndex(y=>y.category===x.category&&y.subcategory===x.subcategory)===i).slice(0,9);
    return intro('FAST ENTRY',item?'거래 수정':'빠른 입력',item?'수정 후 저장하면 기존 거래 1건만 변경됩니다.':'한 건씩 입력하는 화면입니다. 여러 건은 시트형 일괄 입력을 이용하세요.',`<button class="btn" data-page="transactions">거래내역 보기</button>`)+`<div class="quick-layout"><section class="panel"><header class="panel-head"><div><h2>${item?'거래 수정':'새 거래 등록'}</h2><p>원본을 보존하면서 로컬 장부에 반영됩니다.</p></div></header><div class="panel-body"><form id="entry-form"><div class="form-grid"><div class="form-group full"><label>거래 유형</label><div class="radio-tabs">${[['expense','지출'],['income','수입'],['transfer','이체']].map(([k,s])=>`<label><input type="radio" name="kind" value="${k}" ${kind===k?'checked':''}><span>${s}</span></label>`).join('')}</div></div><div class="form-group"><label for="tx-date">날짜</label><input id="tx-date" type="date" name="date" value="${esc(date)}" required></div><div class="form-group"><label for="tx-money">금액 · 원</label><input id="tx-money" name="amount" type="text" inputmode="numeric" value="${item?fmt(item.amount):''}" placeholder="예: 28,500" autocomplete="off" required></div><div class="form-group"><label for="tx-area">구분</label><select id="tx-area" name="area">${['business','personal','review','transfer'].map(v=>`<option value="${v}" ${area===v?'selected':''}>${labelArea(v)}</option>`).join('')}</select></div>${groupControl(expenseGroup,kind)}<div class="form-group"><label for="tx-cat">대분류</label><input list="cat-list" id="tx-cat" name="category" value="${esc(item?.category||'')}" placeholder="예: 담배 발주" required><datalist id="cat-list">${allCats().map(c=>`<option value="${esc(c)}"></option>`).join('')}</datalist></div><div class="form-group"><label for="tx-sub">소분류 (선택)</label><select id="tx-sub" name="subcategory">${subChoices(item?.category||'',item?.subcategory||'')}</select><input id="tx-sub-custom" name="subcategoryCustom" value="" placeholder="새 소분류 이름" hidden></div><div class="form-group"><label for="tx-pay">결제 수단 (선택)</label><input list="pay-list" id="tx-pay" name="payment" value="${esc(item?.payment||'')}" placeholder="예: 현금/송금"><datalist id="pay-list">${allPays().map(c=>`<option value="${esc(c)}"></option>`).join('')}</datalist></div><div class="form-group full"><label for="tx-note">메모 (선택)</label><textarea id="tx-note" name="note" placeholder="가게명, 영수증 또는 설명">${esc(item?.note||'')}</textarea></div></div><div class="form-actions"><button class="btn btn-primary" type="submit">${item?'✓ 수정 저장':'✓ 거래 등록'}</button><button class="btn" type="button" id="reset-entry">입력 초기화</button>${item?'<button class="btn btn-danger" type="button" id="cancel-edit">수정 취소</button>':''}</div></form></div></section><section>${card('자주 입력하는 항목','최근 기록을 바탕으로 한 번에 양식 불러오기',recents.map(x=>`<div class="helper-tile"><div><strong>${esc(x.category)}</strong> ${x.subcategory?`<small class="small-muted">/ ${esc(x.subcategory)}</small>`:''}<small style="display:block;color:#a4afb8;margin-top:3px">${esc(x.payment||'결제수단 없음')}</small></div><button class="btn btn-small" data-repeat="${esc(x.id)}">불러오기</button></div>`).join('')||'<div class="empty">기록을 가져오면 자주 쓰는 항목이 나타납니다.</div>')}${card('효율적인 입력 요령','가게부가 자동으로 처리하는 것',`<div class="note-box"><h3>대분류·소분류 선택</h3><p>대분류를 입력하면 기존 기록과 원본 구글 시트 DB의 소분류가 자동으로 선택지에 나타납니다. 새 항목만 ‘직접 입력’을 사용하세요.</p></div><div class="note-box"><h3>저축은 지출이 아닙니다</h3><p>주택청약 등 통장 간 자금 이동은 ‘저축/이체’로 등록해 수익성 계산에서 제외합니다.</p></div><div class="note-box"><h3>토토 일별 자료는 별도</h3><p>일일 수수료를 기록해도 월말 확정 금액을 이중 합산하지 않습니다.</p></div>`)}</section></div>`;
  };
  const lottoPage=()=>{
    const rows=db.dailyLotto.filter(x=>period==='all'||monthOf(x)===period).sort((a,b)=>b.date.localeCompare(a.date));const list=rows.slice(lottoOffset,lottoOffset+60);
    const monthSums=availableMonths().map(m=>{const d=db.dailyLotto.filter(x=>monthOf(x)===m);const existing=db.transactions.find(x=>monthOf(x)===m&&x.kind==='income'&&x.category==='토토 수수료');return {month:m,count:d.length,amount:sum(d,x=>x.commission),handle:sum(d,x=>x.handle),posted:existing?.amount||0,exists:!!existing}}).filter(x=>x.count||x.exists);
    return intro('LOTTO SALES','토토 매출상세','일별 판매액과 수수료를 보존합니다. 월 확정 수입은 별도로 한 번만 계산됩니다.',periodSelect())+sourceBanner()+lottoBatchPanel()+`<div class="stat-grid">${kpi('일별 수수료 합계',sum(rows,x=>x.commission),'월 확정 수입과 별도 보관','◉')}${kpi('토토 판매액',sum(rows,x=>x.handle),'판매액 전체가 수입은 아닙니다','▤')}${kpi('입력된 날짜',rows.length,'일별 기록 수','▦')}${kpi('확정 월별 수수료',sum(db.transactions.filter(x=>x.kind==='income'&&x.category==='토토 수수료'&&(period==='all'||monthOf(x)===period))),'월별 원장 금액','✓')}</div><div class="grid-two">${card('월별 일별·확정 대조','1~9월은 일별 합계와 월 확정 수입의 일치 여부를 확인했습니다.',`<div class="data-table-wrap"><table class="data-table" style="min-width:480px"><thead><tr><th>월</th><th>일수</th><th class="right">일별 합계</th><th class="right">월 확정</th><th>상태</th></tr></thead><tbody>${monthSums.map(x=>`<tr><td>${esc(x.month)}</td><td>${x.count}일</td><td class="right">${won(x.amount)}</td><td class="right">${x.exists?won(x.posted):'—'}</td><td>${x.exists?(x.amount===x.posted?'<span class="chip business">일치</span>':'<span class="chip review">차이 확인</span>'):(x.count===new Date(Number(x.month.slice(0,4)),Number(x.month.slice(5)),0).getDate()?`<button class="btn btn-small" data-post-lotto="${x.month}">월 확정</button>`:'<span class="chip review">미확정</span>')}</td></tr>`).join('')}</tbody></table></div>`)}${card('토토 일별 자료 입력','판매액과 수수료를 별도로 기입할 수 있습니다.',`<form id="lotto-form"><div class="form-grid"><div class="form-group"><label>날짜</label><input name="date" type="date" value="${ymd()}" required></div><div class="form-group"><label>일 판매액</label><input name="handle" type="text" inputmode="numeric" placeholder="예: 2,000,000"></div><div class="form-group full"><label>수수료 · 원</label><input name="commission" type="text" inputmode="numeric" placeholder="예: 119,400" required></div></div><div class="form-actions"><button class="btn btn-primary">✓ 일별 기록 저장</button></div></form><p class="small-muted mt-10">같은 날짜를 등록하면 기존 값을 수정합니다. 일별 입력은 확정 수입으로 자동 반영되지 않습니다.</p>` )}</div><section class="panel"><header class="panel-head"><div><h2>일별 수수료 기록</h2><p>일별 수수료 · 원시트 판매액</p></div></header><div class="data-table-wrap"><table class="data-table" style="min-width:560px"><thead><tr><th>날짜</th><th class="right">판매액</th><th class="right">수수료</th><th>자료 출처</th><th class="right">관리</th></tr></thead><tbody>${list.length?list.map(x=>`<tr><td>${esc(x.date)}</td><td class="right">${won(x.handle)}</td><td class="right"><strong>${won(x.commission)}</strong></td><td>${esc(x.sourceSheet||'직접 입력')}</td><td class="right"><button class="btn-plain" data-lotto-edit="${esc(x.id)}">수정</button></td></tr>`).join(''):'<tr><td colspan="5" class="empty">기록이 없습니다.</td></tr>'}</tbody></table></div><div class="pager">${lottoOffset+1}–${Math.min(lottoOffset+60,rows.length)} / ${rows.length}일 <button class="btn btn-small" data-lotto-page="prev" ${lottoOffset===0?'disabled':''}>이전</button><button class="btn btn-small" data-lotto-page="next" ${lottoOffset+60>=rows.length?'disabled':''}>다음</button></div></section>`;
  };
  const analysis=()=>{
    const t=current(),s=stat(t),rows=monthOverview().filter(x=>period==='all'||x.m===period),base=t.filter(exp),groups=Object.entries(base.reduce((o,x)=>{const k=x.area+'|'+x.category;o[k]=(o[k]||0)+x.amount;return o},{})).sort((a,b)=>b[1]-a[1]);const max=Math.max(...groups.map(x=>x[1]),1);
    const biz=stat(t.filter(x=>x.area==='business'));
    return intro('SPENDING INTELLIGENCE','지출 분석','가게 매입, 임대료, 생활비를 같은 손익으로 착각하지 않도록 분리합니다.',periodSelect()+`<button class="btn" id="csv-export">↓ CSV</button>`)+sourceBanner()+`<div class="stat-grid">${kpi('사업 지출',s.businessExpense,'발주·담배·운영비·사업 세금','▣')}${kpi('개인 지출',s.personalExpense,'주거·생활·보험 등','⌂')}${kpi('분류 확인 필요',s.unclassified,'임의로 사업/개인 분류하지 않음','?')}${kpi('전체 지출',s.expense,'사업·개인·미분류 합계','↙')}</div>${card('원본 장부별 지출','고정지출과 소비지출은 원본의 장부 구분입니다. 상품·담배 발주처럼 매달 금액이 달라지는 항목도 고정지출에 포함됩니다.',`<div class="metric-line"><span>고정지출</span><strong>${won(sum(t.filter(x=>expenseGroupOf(x)==='fixed')))}</strong></div><div class="metric-line"><span>소비지출</span><strong>${won(sum(t.filter(x=>expenseGroupOf(x)==='consumption')))}</strong></div>`)}<div class="grid-two">${card('지출 분류 TOP 12','비용이 발생한 분야별 내림차순',groups.slice(0,12).map(([key,n],i)=>`<div class="progress-item"><div class="progress-top"><span><span class="chip ${esc(key.split('|')[0])}" style="margin-right:7px">${labelArea(key.split('|')[0])}</span>${esc(key.split('|')[1])}</span><b>${won(n)}</b></div><div class="progress-bar"><i style="width:${(n/max*100).toFixed(1)}%;background:${['#149683','#45a89c','#81b8ae','#8c9fb9','#a9c3bc','#b1b9c8'][i%6]}"></i></div></div>`).join('')||'<div class="empty">지출이 없습니다.</div>')}${card('편의점 비용 구조','실제 영업이익 산출에는 기초·기말 재고와 카드매출 정산액도 필요합니다.',`<div class="metric-line"><span>월별 수입 합계</span><strong>${won(s.businessIncome)}</strong></div><div class="metric-line"><span>사업 지출 합계</span><strong>−${won(s.businessExpense)}</strong></div><div class="metric-line"><strong>사업 장부 차액</strong><strong>${fmtSigned(s.businessIncome-s.businessExpense)}</strong></div><div class="soft-bg"><div class="small-muted">상품을 사들인 시점의 금액을 비용으로 표시합니다. 아직 판매되지 않은 재고까지 비용으로 잡혀 실제 이익과 차이가 납니다.</div></div><div class="metric-line"><span>일반 발주 합계</span><strong>${won(sum(t.filter(x=>x.category==='발주'&&exp(x))))}</strong></div><div class="metric-line"><span>담배 발주 합계</span><strong>${won(sum(t.filter(x=>x.category==='담배 발주'&&exp(x))))}</strong></div><div class="metric-line"><span>가게 유지·운영비</span><strong>${won(sum(t.filter(x=>x.category==='가게'&&exp(x))))}</strong></div><div class="metric-line"><span>개인 지출 + 미분류</span><strong>${won(s.personalExpense+s.unclassified)}</strong></div>` )}</div>${card('월별 비교','1월부터 최근 확정 자료까지',chart(rows))}<section class="panel"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>월</th><th class="right">수입</th><th class="right">사업 지출</th><th class="right">사업 차액</th><th class="right">개인 지출</th><th class="right">미분류</th><th class="right">전체 차액</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.m)}</td><td class="right">${fmt(x.income)}</td><td class="right">${fmt(x.businessExpense)}</td><td class="right ${x.income-x.businessExpense<0?'neg':'pos'}">${fmt(x.income-x.businessExpense)}</td><td class="right">${fmt(x.personalExpense)}</td><td class="right">${fmt(x.unclassified)}</td><td class="right ${x.income-x.expense<0?'neg':'pos'}">${fmt(x.income-x.expense)}</td></tr>`).join('')}</tbody></table></div></section>`;
  };
  const recurring=()=>{
    const candidates=db.transactions.filter(x=>x.kind==='expense'&&x.sourceSheet==='고정지출').reduce((o,x)=>{const key=x.area+'|'+x.category+'|'+x.subcategory+'|'+x.payment;(o[key]??=[]).push(x);return o},{});
    const groups=Object.values(candidates).filter(a=>new Set(a.map(monthOf)).size>=4).map(a=>({latest:sorted(a)[0],count:a.length,months:new Set(a.map(monthOf)).size,average:Math.round(sum(a)/a.length)})).sort((a,b)=>b.months-a.months||b.average-a.average).slice(0,35);
    return intro('RECURRING EXPENSES','반복 지출','지난 기록에서 4개월 이상 반복된 항목을 찾아 다음 달 입력을 간편하게 만듭니다.',`<select id="recurring-month" class="select">${availableMonths().map(m=>`<option value="${esc(m)}" ${m===ymd().slice(0,7)?'selected':''}>${esc(m)}</option>`).join('')}</select>`)+`<div class="banner"><div><strong>반복 지출은 자동 청구하지 않습니다.</strong> 기존 항목을 확인한 후 버튼을 누르면 새로운 월의 거래 입력 양식에 날짜와 분류를 채웁니다. 실제 결제 여부를 확인해 저장하세요.</div></div><section class="panel"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>구분</th><th>항목</th><th>결제 수단</th><th>최근 금액</th><th>관측</th><th>평균</th><th>동작</th></tr></thead><tbody>${groups.map(g=>{const x=g.latest;return `<tr><td>${tag(x.area,x.kind)}</td><td>${esc(x.category)} / ${esc(x.subcategory||'기타')}</td><td>${esc(x.payment||'—')}</td><td>${won(x.amount)}</td><td>${g.months}개월</td><td>${won(g.average)}</td><td><button class="btn btn-small" data-repeat="${esc(x.id)}" data-recurring="1">이번 달 입력</button></td></tr>`}).join('')||'<tr><td colspan="7" class="empty">반복 기록을 찾지 못했습니다.</td></tr>'}</tbody></table></div></section>`;
  };
  const dataPage=()=>{
    const review=sorted(db.transactions.filter(x=>x.area==='review'));const months=availableMonths();const incomeDiff=[];
    for(const m of months){const posted=sum(db.transactions.filter(x=>x.kind==='income'&&x.category==='토토 수수료'&&monthOf(x)===m));const daily=sum(db.dailyLotto.filter(x=>monthOf(x)===m),x=>x.commission);if(daily>0&&posted>0&&daily!==posted)incomeDiff.push({m,posted,daily})}
    return intro('DATA & SAFETY','데이터 관리',connected?'서버 저장이 연결되어 있으며 JSON 백업도 사용할 수 있습니다.':'기본은 로컬 보관입니다. 서버를 배포하고 연결하면 모든 기기에서 같은 기록을 사용합니다.')+serverSettings()+`<div class="comparison"><section class="panel"><header class="panel-head"><div><h2>이관 · 복원</h2><p>구글 시트에서 추출한 전용 JSON 파일 또는 이 사이트에서 내려받은 백업 파일</p></div></header><div class="panel-body"><div class="file-drop"><strong>JSON 파일 불러오기</strong><p class="small-muted">기존 가게부 이관 파일을 선택하세요.</p><label class="small-muted" for="import-mode" style="display:block;margin-top:8px">불러오기 방식</label><select id="import-mode" class="select" style="width:100%;max-width:480px;margin:5px 0 10px"><option value="merge">최신 시트 갱신 · 사이트 직접 입력 보존</option><option value="replace">전체 교체 · JSON 백업 복원</option></select><input id="import-file" type="file" accept="application/json,.json"><p class="small-muted" style="margin-top:8px">가져올 JSON에 들어 있는 시트 거래는 최신 내용으로 갱신합니다. 사이트에서 직접 입력한 거래는 보존합니다. 기존 시트 거래를 사이트에서 수정했다면 가져오기 전 백업해 주세요.</p></div><div class="soft-bg"><div class="kpi-pair"><label>원장 거래</label><strong>${fmt(db.transactions.length)}건</strong></div><div class="kpi-pair"><label>토토 일별 기록</label><strong>${fmt(db.dailyLotto.length)}건</strong></div><div class="kpi-pair"><label>분류 검토 필요</label><strong>${review.length}건</strong></div><div class="kpi-pair"><label>데이터 기준</label><strong>${esc(db.exportedAt||'직접 입력')}</strong></div></div></div></section><section class="panel"><header class="panel-head"><div><h2>백업 · 내보내기</h2><p>기기 변경과 브라우저 데이터 삭제에 대비하세요.</p></div></header><div class="panel-body"><div class="form-actions" style="margin-top:0"><button class="btn btn-primary" id="json-export">↓ JSON 전체 백업</button><button class="btn" id="csv-export">↓ CSV 거래 추출</button></div><div class="note-box mt-10"><h3>민감한 장부는 공개 업로드하지 않습니다</h3><p>이 사이트의 코드만 공개됩니다. 서버에 연결하기 전에는 브라우저에 기록됩니다. 서버 연결 후에는 비공개 D1에 기록되고 로컬에도 사본이 남습니다. 공용 PC에서는 로그인하지 마세요.</p></div><div class="note-box mt-10"><h3>원본 시트 보존</h3><p>구글 스프레드시트의 기존 기록과 수식은 수정하지 않았습니다. 이관은 별도 사본 데이터로 이루어졌습니다.</p></div><button class="btn btn-danger mt-10" id="wipe">이 기기 장부 초기화</button></div></section></div>`+
    (incomeDiff.length?`<div class="banner danger">토토 일별 합계와 월별 확정 수입이 다른 달이 ${incomeDiff.length}개 있습니다: ${incomeDiff.map(x=>esc(x.m)).join(', ')}</div>`:'')+
    (review.length?`<section class="panel"><header class="panel-head"><div><h2>분류 확인 필요 · ${review.length}건</h2><p>종합소득세·지방세 등 편의점과 개인 중 하나로 단정하기 어려운 항목입니다. 원본 시트에서 정정한 거래는 이관 파일에 반영됩니다. 같은 상호의 새 거래에는 자동 적용되지 않습니다.</p></div></header><div class="data-table-wrap"><table class="data-table"><thead><tr><th>날짜</th><th>분류</th><th>메모</th><th class="right">금액</th><th>대상 장부 변경</th></tr></thead><tbody>${review.map(x=>`<tr><td>${esc(x.date)}</td><td>${esc(x.category)} ${esc(x.subcategory||'')}</td><td class="memo">${esc(x.note||'—')}</td><td class="right">${won(x.amount)}</td><td><div class="row-actions" style="justify-content:flex-start"><button class="btn btn-small" data-classify="${esc(x.id)}" data-area="business">사업</button><button class="btn btn-small" data-classify="${esc(x.id)}" data-area="personal">개인</button><button class="btn-plain" data-edit="${esc(x.id)}">상세</button></div></td></tr>`).join('')}</tbody></table></div></section>`:'')+`<div class="footer-note">구글 시트: ${esc(db.sourceTitle||'가계부 2026')} · 이관 데이터 포맷: ${esc(db.schema||'store-ledger-v1')}</div>`;
  };

  // A spreadsheet-like batch editor: each cell is independent, with Tab/arrow navigation
  // and TSV clipboard paste. Blank rows never create transactions.
  const fields=['date','amount','expenseGroup','area','category','subcategory','payment','note'];
  const fieldLabel={date:'날짜',amount:'금액 (원)',expenseGroup:'지출 종류',area:'사용처',category:'대분류',subcategory:'소분류',payment:'결제 수단',note:'메모'};
  const isoDate=value=>{const raw=String(value||'').trim().replace(/[./]/g,'-');const m=raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);if(!m)return '';const y=+m[1],month=+m[2],day=+m[3];if(month<1||month>12||day<1||day>new Date(y,month,0).getDate())return '';return `${y}-${pad(month)}-${pad(day)}`};
  const batchCell=(i,f,value='',kind=sheetKind)=>{
    const common=`class="grid-cell" data-grid="sheet" data-row="${i}" data-col="${f}" aria-label="${i+1}행 ${fieldLabel[f]}"`;
    if(f==='expenseGroup')return '<select '+common+(kind==='expense'?'':' disabled')+' aria-haspopup="listbox" aria-expanded="false">'+[['fixed','고정지출'],['consumption','소비지출']].map(([v,n])=>'<option value="'+v+'"'+((value||'consumption')===v?' selected':'')+'>'+n+'</option>').join('')+'</select>';
    if(f==='area')return `<select ${common} aria-haspopup="listbox" aria-expanded="false">${[['personal','개인'],['business','편의점'],['review','확인 필요'],['transfer','저축/이체']].map(([k,n])=>`<option value="${k}" ${(value||((kind==='income')?'business':'personal'))===k?'selected':''}>${n}</option>`).join('')}</select>`;
    if(f==='category')return `<input ${common} value="${esc(value)}" placeholder="대분류" autocomplete="off" aria-haspopup="listbox" aria-expanded="false">`;
    if(f==='subcategory')return `<input ${common} list="sheet-sub-${i}" value="${esc(value)}" placeholder="선택/직접 입력"><datalist id="sheet-sub-${i}"></datalist>`;
    if(f==='payment')return `<input ${common} list="sheet-pay-list" value="${esc(value)}" placeholder="결제수단">`;
    if(f==='amount')return `<input ${common} type="text" inputmode="decimal" value="${esc(value)}" placeholder="0">`;
    return `<input ${common} type="text" value="${esc(value)}" placeholder="${f==='date'?'YYYY-MM-DD':f==='note'?'메모':''}">`;
  };
  const batchRow=(i,obj={})=>`<tr data-grid-row="${i}"><th scope="row" class="sheet-row-num">${i+1}</th>${fields.map(f=>`<td>${batchCell(i,f,obj[f]??(f==='date'?sheetDate:''))}</td>`).join('')}</tr>`;
  const sheetPage=()=>{
    const pays=allPays();
    return intro('SHEET ENTRY','시트형 일괄 입력','같은 날짜 거래를 여러 줄로 적고 한 번에 저장합니다. 고정지출·소비지출은 원본 장부 구분으로, 매월 반복 고정비 여부와는 다릅니다. 엑셀 여러 칸 붙여넣기도 가능합니다.',`<button class="btn" data-page="quick">1건씩 입력</button>`)+
    `<section class="panel"><div class="sheet-toolbar"><label>입력 종류 <select id="sheet-kind" class="select"><option value="expense" ${sheetKind==='expense'?'selected':''}>지출</option><option value="income" ${sheetKind==='income'?'selected':''}>수입</option><option value="transfer" ${sheetKind==='transfer'?'selected':''}>이체</option></select></label><label>기본 날짜 <input id="sheet-date" type="date" value="${esc(sheetDate)}"></label><button id="sheet-date-fill" class="btn btn-small">모든 행에 날짜 적용</button><button id="sheet-row-add" class="btn btn-small">＋ 10행</button><button id="sheet-clear" class="btn btn-small">비우기</button></div><div class="sheet-hint">입력 순서는 자유입니다. <kbd>Enter</kbd> 구분·대분류 메뉴 열기/선택 · <kbd>↑↓←→</kbd> 셀 이동 (메뉴가 열리면 ↑↓ 항목 선택) · <kbd>Tab</kbd> 다음 칸 · <kbd>Esc</kbd> 메뉴 닫기 · <kbd>Ctrl+V</kbd> 여러 칸 붙여넣기. 빈 금액 행은 저장되지 않습니다.</div><div class="sheet-scroll"><table class="sheet-table" id="sheet-grid"><thead><tr><th scope="col">#</th>${fields.map(f=>`<th scope="col">${fieldLabel[f]}</th>`).join('')}</tr></thead><tbody id="sheet-rows">${Array.from({length:20},(_,i)=>batchRow(i)).join('')}</tbody></table></div><datalist id="sheet-pay-list">${pays.map(x=>`<option value="${esc(x)}"></option>`).join('')}</datalist><div class="sheet-footer"><div id="sheet-count">입력할 거래 0건</div><button id="sheet-save" class="btn btn-primary">✓ 작성된 거래 한 번에 저장</button></div></section>`+
    card('월말 가게 매출','매월 마지막 날에 한 건만 등록합니다. 이미 입력된 월은 중복 생성하지 않고 기존 기록 수정을 확인합니다.',`<form id="monthly-sales-form"><div class="monthly-sales-form"><label>매출 월 <input name="month" type="month" required value="${esc(sheetDate.slice(0,7))}"></label><label>가게 매출액 · 원 <input name="amount" inputmode="numeric" placeholder="월 매출 합계" required></label><label>메모 <input name="note" placeholder="월말 정산 메모 (선택)"></label><button class="btn btn-primary" type="submit">월 매출 저장</button></div></form>`);
  };
  const getSheetCells=()=>[...document.querySelectorAll('#sheet-rows tr')].map(tr=>Object.fromEntries(fields.map(f=>[f,tr.querySelector(`[data-col="${f}"]`)?.value||''])));
  const reindexGrid=()=>{const rows=[...document.querySelectorAll('#sheet-rows tr')];for(let i=0;i<rows.length;i++){rows[i].dataset.gridRow=i;rows[i].querySelector('.sheet-row-num').textContent=i+1;rows[i].querySelectorAll('[data-grid="sheet"]').forEach(x=>{x.dataset.row=i;x.setAttribute('aria-label',`${i+1}행 ${fieldLabel[x.dataset.col]}`)})}};
  const addBatchRows=(count=10)=>{const body=document.querySelector('#sheet-rows');if(!body)return;const start=body.children.length;if(start+count>300){toast('한 번에 최대 300행을 입력할 수 있습니다.');return}body.insertAdjacentHTML('beforeend',Array.from({length:count},(_,i)=>batchRow(start+i)).join(''));for(let i=start;i<start+count;i++)fillSubChoices(i)};
  const fillSubChoices=i=>{const tr=document.querySelector(`#sheet-rows tr[data-grid-row="${i}"]`);if(!tr)return;const cat=tr.querySelector('[data-col="category"]')?.value||'',options=tr.querySelector('datalist[id^="sheet-sub-"]');if(options)options.innerHTML=subcategories(cat).map(x=>`<option value="${esc(x)}"></option>`).join('')};

  // Consistent Enter/arrow picker for sheet Area and Main Category.
  let sheetPicker=null;
  const closeSheetPicker=()=>{
    if(!sheetPicker)return;
    const {cell,panel}=sheetPicker;
    cell.setAttribute('aria-expanded','false');
    cell.removeAttribute('aria-controls');
    cell.removeAttribute('aria-activedescendant');
    panel.remove();sheetPicker=null;
  };
  const markSheetPicker=()=>{
    if(!sheetPicker)return;
    const {panel,cell,active}=sheetPicker;
    panel.querySelectorAll('[data-choice-index]').forEach((item,i)=>{
      const on=i===active;item.classList.toggle('active',on);
      item.setAttribute('aria-selected',String(on));
    });
    const selected=panel.querySelector('[data-choice-index="'+active+'"]');
    if(selected){
      cell.setAttribute('aria-activedescendant',selected.id);
      if(selected.offsetTop<panel.scrollTop)panel.scrollTop=selected.offsetTop;
      else if(selected.offsetTop+selected.offsetHeight>panel.scrollTop+panel.clientHeight)
        panel.scrollTop=selected.offsetTop+selected.offsetHeight-panel.clientHeight;
    }
  };
  const openSheetPicker=(cell,filter=false)=>{
    if(cell?.dataset.grid!=='sheet'||!['expenseGroup','area','category'].includes(cell.dataset.col))return;
    closeSheetPicker();
    const selectCell=cell.tagName==='SELECT';
    const items=selectCell?[...cell.options].map(x=>({value:x.value,label:x.textContent})):
      allCats().map(x=>({value:x,label:x}));
    const query=filter?cell.value.trim().toLocaleLowerCase('ko'):'';
    const options=query?items.filter(x=>x.label.toLocaleLowerCase('ko').includes(query)):items;
    const rect=cell.getBoundingClientRect(),vpWidth=document.documentElement.clientWidth;
    const width=Math.min(Math.max(rect.width,175),vpWidth-16);
    const panel=document.createElement('div');
    panel.className='sheet-choice-picker';
    panel.id='sheet-choice-list';
    panel.setAttribute('role','listbox');
    panel.setAttribute('aria-label',cell.dataset.col==='expenseGroup'?'지출 종류 선택':cell.dataset.col==='area'?'사용처 선택':'대분류 선택');
    panel.style.width=width+'px';
    panel.style.left=Math.max(8,Math.min(rect.left,vpWidth-width-8))+'px';
    const above=rect.top,beneath=window.innerHeight-rect.bottom;
    const upward=beneath<160&&above>beneath;
    panel.style.maxHeight=Math.max(80,Math.min(248,(upward?above:beneath)-12))+'px';
    if(upward)panel.style.bottom=(window.innerHeight-rect.top+3)+'px';
    else panel.style.top=(rect.bottom+3)+'px';
    panel.innerHTML=options.length?options.map((opt,i)=>
      '<button type="button" class="sheet-choice-option" data-choice-index="'+i+'" id="sheet-choice-option-'+i+'" role="option" aria-selected="false">'+esc(opt.label)+'</button>'
    ).join(''):'<div class="sheet-choice-empty">일치하는 분류가 없습니다. 직접 입력할 수 있습니다.</div>';
    document.body.appendChild(panel);
    cell.setAttribute('aria-expanded','true');
    cell.setAttribute('aria-controls',panel.id);
    const selectedIndex=options.findIndex(x=>x.value===cell.value);
    sheetPicker={cell,panel,options,active:selectedIndex>=0?selectedIndex:options.length?0:-1};
    markSheetPicker();
  };
  const chooseSheetPicker=index=>{
    if(!sheetPicker)return;
    const {cell,options}=sheetPicker,chosen=options[index];
    closeSheetPicker();
    if(!chosen)return;
    if(cell.value!==chosen.value){
      cell.value=chosen.value;
      cell.dispatchEvent(new Event('input',{bubbles:true}));
      cell.dispatchEvent(new Event('change',{bubbles:true}));
    }
    cell.focus();
  };
  const activeCell=(grid,row,col)=>document.querySelector(`[data-grid="${grid}"][data-row="${row}"][data-col="${col}"]`);
  const moveGrid=(grid,row,col,dy,dx)=>{
    closeSheetPicker();
    const cols=grid==='sheet'?fields:['commission','handle'];const nextCol=Math.max(0,Math.min(cols.length-1,cols.indexOf(col)+dx));let nextRow=Math.max(0,row+dy);
    if(grid==='sheet'&&!activeCell(grid,nextRow,cols[nextCol])&&nextRow<300)addBatchRows(10);
    const t=activeCell(grid,nextRow,cols[nextCol]);if(t){t.focus();t.select?.();return true}return false;
  };
  const gridPaste=(e,grid)=>{
    const raw=e.clipboardData?.getData('text/plain');if(!raw||(!raw.includes('\t')&&!raw.includes('\n')))return;
    const origin=e.target,row=Number(origin.dataset.row),col=origin.dataset.col;
    const columns=grid==='sheet'?fields:['commission','handle'];const start=columns.indexOf(col);if(start<0)return;
    const lines=raw.replace(/\r/g,'').replace(/\n$/,'').split('\n').map(line=>line.split('\t'));
    if(lines.length>300||(grid==='sheet'&&row+lines.length>300)){toast('한 번에 최대 300행까지 붙여넣을 수 있습니다.');e.preventDefault();return}
    e.preventDefault();
    if(grid==='sheet')while(document.querySelectorAll('#sheet-rows tr').length<row+lines.length)addBatchRows(10);
    let n=0;
    for(let i=0;i<lines.length;i++)for(let j=0;j<lines[i].length;j++){
      const column=columns[start+j];if(!column)continue;const input=activeCell(grid,row+i,column);if(!input)continue;
      input.value=lines[i][j];input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));n++;
    }
    countSheetRows();toast(`${n}칸을 붙여넣었습니다.`);
  };
  const countSheetRows=()=>{const el=document.querySelector('#sheet-count');if(el){const n=getSheetCells().filter(x=>String(x.amount).trim()!=='').length;el.textContent=`입력할 거래 ${n}건`}};
  const saveSheetBatch=()=>{
    const records=getSheetCells().filter(x=>String(x.amount).trim()!=='');
    if(!records.length){toast('금액을 입력한 행이 없습니다.');return}
    const errors=[];
    const prepared=records.map((x,i)=>{
      const date=isoDate(x.date),amount=val(x.amount),category=String(x.category).trim();
      if(!date||!(amount>0)||!category)errors.push(`${i+1}번째 입력 거래: 날짜·금액·대분류 확인`);
      const kind=sheetKind,area=kind==='transfer'?'transfer':x.area;
      const expenseGroup=kind==='expense'?(x.expenseGroup||inferExpenseGroup(category)):'';
      return {id:'new-'+crypto.randomUUID(),date,amount,kind,area,expenseGroup,category,subcategory:String(x.subcategory).trim(),payment:String(x.payment).trim(),note:String(x.note).trim(),sourceSheet:'직접 입력',sourceRow:null};
    });
    if(errors.length){toast(errors.slice(0,3).join(' / '));return}
    if(sheetKind==='income'&&prepared.some(x=>x.category==='토토 수수료'||x.category==='가게 매출')){
      toast('월별 토토 확정·가게 매출은 전용 입력 메뉴에서 등록하세요.');return
    }
    if(!confirm(`${prepared.length}건 · 합계 ${won(sum(prepared))}을 한 번에 등록할까요?`))return;
    const old=db.transactions;db.transactions=[...old,...prepared];
    if(!save()){db.transactions=old;return}
    const n=prepared.length;render();toast(`${n}건 일괄 저장 완료`);
  };
  const saveMonthlySales=form=>{
    const d=new FormData(form),month=String(d.get('month')),amount=val(d.get('amount'));
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||!(amount>0)){toast('매출 월과 금액을 입력해 주세요.');return}
    const exists=db.transactions.filter(x=>x.kind==='income'&&x.category==='가게 매출'&&monthOf(x)===month);
    if(exists.length>1){toast('해당 월의 매출이 여러 건입니다. 거래내역에서 먼저 확인해 주세요.');return}
    const day=pad(new Date(Number(month.slice(0,4)),Number(month.slice(5)),0).getDate());
    if(exists.length&&!confirm(`${month} 가게 매출 ${won(exists[0].amount)}을 ${won(amount)}으로 수정할까요?`))return;
    if(!exists.length&&!confirm(`${month} 가게 매출 ${won(amount)} 1건을 등록할까요?`))return;
    const old=JSON.stringify(db.transactions);let record=exists[0];
    if(!record){record={id:'monthly-sales-'+month,sourceSheet:'사이트 월 마감',sourceRow:null};db.transactions.push(record)}
    Object.assign(record,{date:`${month}-${day}`,kind:'income',area:'business',category:'가게 매출',subcategory:'',amount,payment:'',note:String(d.get('note')||'').trim()||record.note||''});
    if(!save()){db.transactions=JSON.parse(old);return}render();toast(`${month} 가게 매출을 저장했습니다.`);
  };
  const lottoGrid=month=>{
    const [year,m]=month.split('-').map(Number),days=new Date(year,m,0).getDate();
    return `<div class="sheet-scroll"><table class="sheet-table" id="lotto-batch-grid"><thead><tr><th>#</th><th>날짜 · 자동</th><th>수수료 (원)</th><th>일 판매액 (원)</th></tr></thead><tbody>${Array.from({length:days},(_,i)=>{
      const date=`${month}-${pad(i+1)}`,x=db.dailyLotto.find(x=>x.date===date);
      return `<tr><th class="sheet-row-num">${i+1}</th><td class="sheet-date-readonly">${date}</td><td><input class="grid-cell" data-grid="lotto" data-row="${i}" data-col="commission" aria-label="${date} 수수료" inputmode="numeric" value="${x?fmt(x.commission):''}" placeholder="수수료"></td><td><input class="grid-cell" data-grid="lotto" data-row="${i}" data-col="handle" aria-label="${date} 판매액" inputmode="numeric" value="${x?fmt(x.handle):''}" placeholder="판매액"></td></tr>`;
    }).join('')}</tbody></table></div>`;
  };
  const lottoBatchPanel=()=>card('한 달치 토토 일괄 입력','해당 월의 날짜 28~31개가 자동 생성됩니다. 수수료 열부터 쭉 입력하고 월말에 한 번 저장하세요.',`<div class="sheet-toolbar"><label>입력 월 <input type="month" id="lotto-batch-month" value="${esc(lottoEntryMonth)}"></label><span class="small-muted">이미 있는 날짜는 수정되고, 빈 날짜는 변경되지 않습니다.</span></div>${lottoGrid(lottoEntryMonth)}<div class="sheet-footer"><span>토토 일별 기록은 월 확정 수입과 별도 관리됩니다.</span><button id="lotto-batch-save" class="btn btn-primary">✓ 한 달치 한 번에 저장</button></div>`);
  const saveLottoBatch=()=>{
    const cells=[...document.querySelectorAll('#lotto-batch-grid tbody tr')],updates=[];const errors=[];
    for(let i=0;i<cells.length;i++){
      const tr=cells[i],date=`${lottoEntryMonth}-${pad(i+1)}`;
      const cm=tr.querySelector('[data-col="commission"]'),hm=tr.querySelector('[data-col="handle"]');
      const cr=cm.value.trim(),hr=hm.value.trim();if(!cr&&!hr)continue;
      if(!cr){errors.push(`${i+1}일 수수료 미입력`);continue}
      if(!/^\s*[0-9,]+\s*$/.test(cr)||hr&&!/^\s*[0-9,]+\s*$/.test(hr)){errors.push(`${i+1}일 금액 형식 오류`);continue}
      updates.push({date,commission:val(cr),handle:hr?val(hr):null});
    }
    if(errors.length){toast(errors.slice(0,4).join(' / '));return}
    if(!updates.length){toast('입력된 날짜가 없습니다.');return}
    const old=JSON.stringify(db.dailyLotto),existing=updates.filter(x=>db.dailyLotto.some(z=>z.date===x.date)).length;
    if(!confirm(`${lottoEntryMonth} · ${updates.length}일 중 ${existing}일은 기존 값 수정, ${updates.length-existing}일은 새 기록으로 저장합니다. 계속할까요?`))return;
    for(const u of updates){let rec=db.dailyLotto.find(x=>x.date===u.date);
      if(!rec){rec={id:'lotto-'+u.date,date:u.date,sourceSheet:'직접 입력',sourceRow:null};db.dailyLotto.push(rec)}
      rec.commission=u.commission;if(u.handle!==null)rec.handle=u.handle;
    }
    if(!save()){db.dailyLotto=JSON.parse(old);return}period=lottoEntryMonth;render();toast(`${updates.length}일치 토토 기록을 저장했습니다.`);
  };

  const views={dashboard,transactions,quick,sheet:sheetPage,lotto:lottoPage,analysis,recurring,data:dataPage};
  const render=()=>{document.title=`${NAV[page]} · 가게부`;document.querySelector('#section-title').textContent=NAV[page];document.querySelectorAll('[data-page]').forEach(n=>n.classList.toggle('active',n.dataset.page===page));document.querySelector('#content').innerHTML=views[page]();document.querySelector('#sidebar').classList.remove('open');if(connected)setSyncLabel(syncBlocked?'서버 저장 확인 필요':awaitingInitialUpload?'최초 업로드 필요':'서버 저장 연결됨');if(page==='quick')setTimeout(()=>document.querySelector('#tx-money')?.focus(),30);if(page==='sheet'){for(let i=0;i<20;i++)fillSubChoices(i);setTimeout(()=>activeCell('sheet',0,'amount')?.focus(),30)}};
  const go=p=>{if(!views[p])p='dashboard';lastView=page;page=p;ledgerOffset=0;lottoOffset=0;render();window.scrollTo({top:0,behavior:'instant'})};
  const download=(name,body,type='application/json;charset=utf-8')=>{const blob=new Blob([body],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000)};
  const exportJSON=()=>download(`가게부_백업_${ymd()}.json`,JSON.stringify({...db,backupAt:new Date().toISOString()},null,2));
  const exportCSV=()=>{const cols=['date','kind','expenseGroup','area','category','subcategory','amount','payment','note','sourceSheet','sourceRow'];const csv=[['날짜','유형','지출 종류','사용처','대분류','소분류','금액','결제수단','메모','원본시트','원본행'].join(','),...sorted(current()).map(x=>cols.map(k=>{let v=k==='expenseGroup'?labelExpenseGroup(x):(x[k]??'');if(k==='kind')v=labelKind(v);if(k==='area')v=labelArea(v);return `"${String(v).replaceAll('"','""')}"`}).join(','))].join('\r\n');download(`가게부_거래내역_${period==='all'?'2026':period}.csv`,'\ufeff'+csv,'text/csv;charset=utf-8')};
  const importJSON=async file=>{
    if(!file)return;
    let o;
    try{o=JSON.parse(await file.text())}catch(e){toast('JSON을 읽지 못했습니다.');return}
    if(o.schema!=='store-ledger-v1'||!Array.isArray(o.transactions)||!Array.isArray(o.dailyLotto)){toast('가게부 백업 형식이 아닙니다.');return}
    if(o.transactions.some(x=>!x.id||!/^\d{4}-\d{2}-\d{2}$/.test(x.date)||!Number.isFinite(Number(x.amount))||Number(x.amount)<0)
      ||o.dailyLotto.some(x=>!x.id||!/^\d{4}-\d{2}-\d{2}$/.test(x.date)||!Number.isFinite(Number(x.commission)))){
      toast('일부 거래 또는 토토 자료의 날짜/금액이 올바르지 않습니다.');return
    }
    if(new Set(o.transactions.map(x=>String(x.id))).size!==o.transactions.length
      ||new Set(o.dailyLotto.map(x=>String(x.id))).size!==o.dailyLotto.length){
      toast('이관 파일에 중복된 거래 ID가 있습니다.');return
    }
    const mode=document.querySelector('#import-mode')?.value||'merge';
    const isSheetSnapshot=o.transactions.some(x=>['수입','고정지출','소비지출'].includes(x.sourceSheet));
    const merge=mode==='merge'&&isSheetSnapshot&&db.transactions.length>0;
    const ids=new Set(o.transactions.map(x=>String(x.id)));
    const days=new Set(o.dailyLotto.map(x=>String(x.date)));
    const postedLottoMonths=new Set(o.transactions.filter(x=>x.kind==='income'&&x.category==='토토 수수료').map(monthOf));
    const localRecords=merge?db.transactions.filter(x=>
      !ids.has(String(x.id)) &&
      (x.sourceSheet==='직접 입력'||x.sourceSheet==='사이트 월 마감'||String(x.id).startsWith('new-')||String(x.id).startsWith('confirmed-lotto-')) &&
      !(x.category==='토토 수수료'&&x.kind==='income'&&postedLottoMonths.has(monthOf(x)))
    ):[];
    const localLotto=merge?db.dailyLotto.filter(x=>!days.has(String(x.date))&&x.sourceSheet==='직접 입력'):[];
    const label=`시트/백업 거래 ${o.transactions.length}건, 토토 일별 ${o.dailyLotto.length}건`;
    const msg=merge
      ?`${label}을 적용하고 현재 사이트의 직접 입력 ${localRecords.length}건, 별도 토토 기록 ${localLotto.length}건을 유지합니다.\n원본 시트에서 가져온 기존 거래는 최신 파일 내용으로 바뀝니다.\n안전을 위해 먼저 JSON 백업을 권장합니다. 계속할까요?`
      :db.transactions.length?`${label}을 가져오면 현재 브라우저 장부를 전체 교체합니다.\n기존 자료를 JSON으로 백업하셨나요? 계속할까요?`
      :`${label}을 이 브라우저에 이관하시겠습니까?`;
    if(!confirm(msg))return;
    const previous=db;
    db={...empty(),...o,transactions:[...o.transactions,...localRecords],dailyLotto:[...o.dailyLotto,...localLotto]};
    upgrade(db);
    if(!save()){db=previous;return}
    period='all';filters={query:'',area:'all',kind:'all',expenseGroup:'all',category:'all'};
    go('dashboard');
    toast(merge?`시트 갱신 완료 · 수기 입력 ${localRecords.length}건 보존`:`이관 완료: ${label}`);
  };
  const classified=(id,area)=>{const x=db.transactions.find(z=>z.id===id);if(!x)return;x.area=area;save();render();toast(`${labelArea(area)}으로 분류했습니다.`)};
  const selectCategory=()=>{
    const e=document.querySelector('#tx-cat'),a=document.querySelector('#tx-area'),k=document.querySelector('input[name="kind"]:checked');
    if(!e||!a||!k)return;
    const cat=e.value,kind=k.value;
    const wrap=document.querySelector('#tx-expense-group-wrap');if(wrap)wrap.hidden=kind!=='expense';
    const group=document.querySelector('#tx-expense-group');if(group&&!group.dataset.manual)group.value=inferExpenseGroup(cat);
    if(kind==='income'){a.value='business';return}
    if(kind==='transfer'){a.value='transfer';return}
    if(['담배 발주','발주','가게'].includes(cat))a.value='business';
    else if(['집','보험','건보/연금','편의점','외식/배달','식재료','여행','쇼핑','건강/미용','병원/약국','교통비'].includes(cat))a.value='personal';
    else if(cat==='세금')a.value='review';
    else if(cat==='저축')a.value='transfer';
  };
  const entrySave=form=>{
    const data=new FormData(form),date=String(data.get('date')),amount=val(data.get('amount'));
    const category=String(data.get('category')||'').trim(),kind=String(data.get('kind')),area=String(data.get('area')),expenseGroup=kind==='expense'?String(data.get('expenseGroup')||inferExpenseGroup(category)):'';
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!(amount>0)||!category){toast('날짜 · 금액 · 분류를 확인해 주세요.');return}
    let subcategory=String(data.get('subcategory')||'').trim();
    if(subcategory==='__custom__')subcategory=String(data.get('subcategoryCustom')||'').trim();
    if(kind==='income'&&category==='토토 수수료'&&db.transactions.some(x=>x.id!==editId&&x.kind==='income'&&x.category==='토토 수수료'&&monthOf(x)===date.slice(0,7))){if(!confirm('같은 달에 토토 확정 수입이 이미 있습니다. 중복 등록 가능성이 있습니다. 그래도 저장하시겠습니까?'))return}
    let rec=editId?db.transactions.find(x=>x.id===editId):null;
    if(!rec){rec={id:'new-'+crypto.randomUUID(),sourceSheet:'직접 입력',sourceRow:null};db.transactions.push(rec)}
    Object.assign(rec,{date,amount,kind,area:kind==='transfer'?'transfer':area,expenseGroup,category,subcategory,payment:String(data.get('payment')||'').trim(),note:String(data.get('note')||'').trim()});
    delete rec.counterparty;
    if(save()){editId=null;go('transactions');toast('거래가 저장되었습니다.')}
  };
  const prefill=(id,isRecurring=false)=>{
    const x=db.transactions.find(y=>y.id===id);if(!x)return;
    editId=null;go('quick');
    const m=isRecurring?(document.querySelector('#recurring-month')?.value||ymd().slice(0,7)):ymd().slice(0,7);
    let dt=ymd();if(isRecurring){const day=Math.min(Number(x.date.slice(8)),new Date(Number(m.slice(0,4)),Number(m.slice(5)),0).getDate());dt=m+'-'+pad(day)}
    const f=document.querySelector('#entry-form');
    f.querySelector('[name="date"]').value=dt;
    f.querySelector('[name="amount"]').value=fmt(x.amount);
    f.querySelector(`[name="kind"][value="${x.kind}"]`).checked=true;
    for(const k of ['area','category','payment','note'])f.querySelector(`[name="${k}"]`).value=x[k]||'';
    refreshSub(x.subcategory||'');
    f.querySelector('[name="expenseGroup"]').value=expenseGroupOf(x)||'consumption';
    const wrap=f.querySelector('#tx-expense-group-wrap');if(wrap)wrap.hidden=x.kind!=='expense';
    f.querySelector('[name="amount"]').focus();toast('기존 거래 양식을 불러왔습니다. 날짜와 금액을 확인하세요.');
  };
  const edit=id=>{editId=id;go('quick')};
  const deleteTx=id=>{const x=db.transactions.find(z=>z.id===id);if(!x)return;if(!confirm(`${x.date} · ${x.category} · ${won(x.amount)} 거래를 삭제할까요?`))return;db.transactions=db.transactions.filter(z=>z.id!==id);if(save()){render();toast('거래가 삭제되었습니다.')}};
  const editLotto=id=>{const x=db.dailyLotto.find(z=>z.id===id);if(!x)return;const f=document.querySelector('#lotto-form');if(!f)return;for(const k of ['date','handle','commission'])f.querySelector(`[name="${k}"]`).value=x[k]??'';f.querySelector('[name="commission"]').focus();toast('일별 값을 수정하고 저장하면 반영됩니다.')};
  const saveLotto=form=>{const d=new FormData(form),date=String(d.get('date')),commission=val(d.get('commission')),handle=val(d.get('handle'));if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!(commission>=0)||!String(d.get('commission')).trim()){toast('날짜와 수수료를 입력하세요.');return}let x=db.dailyLotto.find(y=>y.date===date);if(!x){x={id:'lotto-'+date,date,sourceSheet:'직접 입력',sourceRow:null};db.dailyLotto.push(x)}Object.assign(x,{commission,handle,date});if(save()){period=date.slice(0,7);render();toast('토토 일별 수수료를 저장했습니다.')}};
  const safeClick=fn=>{try{fn()}catch(e){console.error(e);toast('요청을 처리하는 중 오류가 발생했습니다.')}};
  document.addEventListener('click',e=>safeClick(()=>{
    const b=e.target.closest('button,a');if(!b)return;
    if(b.id==='server-pull'){if(confirm('이 브라우저의 미동기화 변경을 JSON으로 백업하셨나요? 서버 자료를 다시 불러올까요?')){localStorage.removeItem(PENDING);syncBlocked=false;void pullServer()}return}
    if(b.id==='server-push'){if(!connected)return;if(serverVersion===0&&db.transactions.length&&!confirm('현재 브라우저 장부를 비어 있는 서버에 최초 업로드할까요?'))return;syncBlocked=false;void uploadServer();return}
    if(b.id==='server-logout'){if(apiToken)void apiCall('/api/logout',{method:'POST'}).catch(()=>{});apiToken='';sessionStorage.removeItem(SESSION);connected=false;syncBlocked=false;serverVersion=null;setSyncLabel('로컬 보관');render();return}
    if(b.id==='sheet-row-add'){addBatchRows(10);return}
    if(b.id==='sheet-date-fill'){sheetDate=document.querySelector('#sheet-date')?.value||sheetDate;document.querySelectorAll('#sheet-rows [data-col="date"]').forEach(x=>x.value=sheetDate);return}
    if(b.id==='sheet-clear'){if(confirm('작성 중인 시트 입력 내용을 모두 지울까요?'))render();return}
    if(b.id==='sheet-save'){saveSheetBatch();return}
    if(b.id==='lotto-batch-save'){saveLottoBatch();return}
    if(b.dataset.page){e.preventDefault();editId=null;go(b.dataset.page);return}
    if(b.dataset.edit){edit(b.dataset.edit);return}
    if(b.dataset.delete){deleteTx(b.dataset.delete);return}
    if(b.dataset.repeat){const x=db.transactions.find(z=>z.id===b.dataset.repeat);const recur=!!b.dataset.recurring;const monthSelect=document.querySelector('#recurring-month');const targetMonth=monthSelect?.value;prefill(b.dataset.repeat,false);if(recur&&targetMonth){const f=document.querySelector('#entry-form');const day=Math.min(Number(x.date.slice(8)),new Date(Number(targetMonth.slice(0,4)),Number(targetMonth.slice(5)),0).getDate());f.querySelector('[name="date"]').value=targetMonth+'-'+pad(day)}return}
    if(b.dataset.classify){classified(b.dataset.classify,b.dataset.area);return}
    if(b.dataset.lottoEdit){editLotto(b.dataset.lottoEdit);return}
    if(b.dataset.postLotto){const m=b.dataset.postLotto;const days=db.dailyLotto.filter(x=>monthOf(x)===m);const expected=new Date(Number(m.slice(0,4)),Number(m.slice(5)),0).getDate();if(days.length!==expected){toast('해당 월 일별 자료가 모두 있어야 합니다.');return}if(db.transactions.some(x=>x.kind==='income'&&x.category==='토토 수수료'&&monthOf(x)===m)){toast('이미 확정 수입이 있습니다.');return}const total=sum(days,x=>x.commission);if(!confirm(`${m}의 수수료 ${won(total)}을 월 확정 수입에 등록할까요?`))return;db.transactions.push({id:'confirmed-lotto-'+m,date:m+'-'+pad(expected),amount:total,kind:'income',area:'business',category:'토토 수수료',subcategory:'',payment:'',note:'일별 수수료 합계로 월 마감',sourceSheet:'사이트 월 마감',sourceRow:null});save();render();toast('월 확정 수입이 등록되었습니다.');return}
    if(b.dataset.offset){ledgerOffset=Math.max(0,ledgerOffset+(b.dataset.offset==='next'?80:-80));render();return}
    if(b.dataset.lottoPage){lottoOffset=Math.max(0,lottoOffset+(b.dataset.lottoPage==='next'?60:-60));render();return}
    if(b.id==='menu-toggle'){document.querySelector('#sidebar').classList.toggle('open');return}
    if(b.id==='json-export'){exportJSON();toast('JSON 전체 백업을 저장했습니다.');return}
    if(b.id==='csv-export'){exportCSV();return}
    if(b.id==='reset-entry'){editId=null;go('quick');return}
    if(b.id==='cancel-edit'){editId=null;go('transactions');return}
    if(b.id==='wipe'){if(connected){toast('서버 연결 중에는 장부를 초기화할 수 없습니다. 먼저 서버에서 로그아웃하세요.');return}if(confirm('이 브라우저에 보관된 장부가 모두 삭제됩니다. JSON 백업을 보관하셨나요?')&&confirm('되돌릴 수 없습니다. 정말 초기화하시겠습니까?')){db=empty();localStorage.removeItem(KEY);period='all';go('data');toast('이 브라우저의 장부를 초기화했습니다.')}return}
  }));
  document.addEventListener('submit',e=>safeClick(()=>{if(e.target.id==='entry-form'){e.preventDefault();entrySave(e.target)}if(e.target.id==='lotto-form'){e.preventDefault();saveLotto(e.target)}if(e.target.id==='monthly-sales-form'){e.preventDefault();saveMonthlySales(e.target)}if(e.target.id==='server-login-form'){e.preventDefault();void loginServer(e.target)}}));
  document.addEventListener('change',e=>safeClick(()=>{
    const el=e.target;
    if(el.id==='sheet-kind'){if(getSheetCells().some(x=>x.amount.trim())&&!confirm('입력 종류를 바꾸면 작성 중인 값이 초기화됩니다. 계속할까요?')){el.value=sheetKind;return}sheetKind=el.value;render();return}
    if(el.id==='sheet-date'){sheetDate=el.value;return}
    if(el.id==='lotto-batch-month'){if([...document.querySelectorAll('#lotto-batch-grid [data-grid]')].some(x=>x.value!==x.defaultValue)&&!confirm('입력 월을 바꾸면 작성 중인 값이 초기화됩니다. 계속할까요?')){el.value=lottoEntryMonth;return}lottoEntryMonth=el.value;period=lottoEntryMonth;render();return}
    if(el.dataset.grid==='sheet'&&el.dataset.col==='category'){fillSubChoices(Number(el.dataset.row));return}
    if(el.dataset.grid==='sheet'&&el.dataset.col==='area'){el.dataset.manual='1';return}
    if(el.dataset.grid==='sheet'&&el.dataset.col==='expenseGroup'){el.dataset.manual='1';return}
    if(el.id==='tx-expense-group'){el.dataset.manual='1';return}
    if(el.id==='f-expense-group'){filters.expenseGroup=el.value;ledgerOffset=0;render();return}
    if(el.id==='period-select'){period=el.value;if(page==='lotto'&&period!=='all')lottoEntryMonth=period;ledgerOffset=0;lottoOffset=0;render();return}
    if(el.id==='import-file'){importJSON(el.files?.[0]);return}
    if(el.id==='f-query'){filters.query=el.value;ledgerOffset=0;render();return}
    if(el.id==='f-area'){filters.area=el.value;ledgerOffset=0;render();return}
    if(el.id==='f-kind'){filters.kind=el.value;ledgerOffset=0;render();return}
    if(el.id==='f-category'){filters.category=el.value;ledgerOffset=0;render();return}
    if(el.id==='tx-cat'){selectCategory();refreshSub();return}
    if(el.name==='kind'){selectCategory();return}
    if(el.id==='tx-sub'){const custom=document.querySelector('#tx-sub-custom');if(custom){custom.hidden=el.value!=='__custom__';if(!custom.hidden)custom.focus()}return}
  }));
  document.addEventListener('input',e=>safeClick(()=>{
    const el=e.target;
    if(el.dataset.grid==='sheet'){if(el.dataset.col==='category'){if(sheetPicker?.cell===el)openSheetPicker(el,true);fillSubChoices(Number(el.dataset.row));const row=el.closest('tr');const group=row.querySelector('[data-col="expenseGroup"]');if(group&&!group.dataset.manual)group.value=inferExpenseGroup(el.value);const area=row.querySelector('[data-col="area"]');if(!area.dataset.manual){const cat=el.value;if(['담배 발주','발주','가게'].includes(cat))area.value='business';else if(cat==='저축')area.value='transfer';else if(cat==='세금')area.value='review';else if(cat)area.value='personal';}}countSheetRows();return}
    if(el.id==='f-query'){const start=el.selectionStart||0;filters.query=el.value;ledgerOffset=0;render();const next=document.querySelector('#f-query');next.focus();next.setSelectionRange(start,start);return}
    if(el.id==='tx-cat'){selectCategory();refreshSub();return}
    if(el.id==='tx-money'||(el.closest('#lotto-form')&&['handle','commission'].includes(el.name))){const pos=el.selectionStart,old=el.value,clean=old.replace(/[^\d]/g,'');el.value=clean?fmt(Number(clean)):'';if(typeof pos==='number')el.setSelectionRange(el.value.length,el.value.length)}
  }));
  document.addEventListener('paste',e=>{const grid=e.target?.dataset?.grid;if(grid==='sheet'||grid==='lotto')gridPaste(e,grid)});

  document.addEventListener('pointerdown',e=>{
    if(sheetPicker?.panel.contains(e.target)){
      const item=e.target.closest?.('[data-choice-index]');
      if(item){e.preventDefault();chooseSheetPicker(Number(item.dataset.choiceIndex))}
      return;
    }
    const selectCell=e.target.closest?.('[data-grid="sheet"][data-col="area"],[data-grid="sheet"][data-col="expenseGroup"]');
    if(selectCell&&!selectCell.disabled){
      e.preventDefault();selectCell.focus();
      if(sheetPicker?.cell===selectCell)closeSheetPicker();else openSheetPicker(selectCell);
      return;
    }
    if(sheetPicker&&e.target!==sheetPicker.cell)closeSheetPicker();
  },true);
  document.addEventListener('click',e=>{
    const category=e.target.closest?.('[data-grid="sheet"][data-col="category"]');
    if(category&&sheetPicker?.cell!==category)openSheetPicker(category);
  });
  document.addEventListener('focusin',e=>{
    if(sheetPicker&&e.target!==sheetPicker.cell&&!sheetPicker.panel.contains(e.target))closeSheetPicker();
  });
  document.addEventListener('scroll',e=>{
    if(sheetPicker&&!sheetPicker.panel.contains(e.target))closeSheetPicker();
  },true);
  document.addEventListener('keydown',e=>{
    if(e.isComposing||e.keyCode===229)return; // Do not interrupt Korean IME confirmation.
    const grid=e.target?.dataset?.grid;
    if(grid==='sheet'||grid==='lotto'){
      const row=Number(e.target.dataset.row),col=e.target.dataset.col;
      const pickable=grid==='sheet'&&(col==='area'||col==='category'||col==='expenseGroup'&&!e.target.disabled);
      if(sheetPicker?.cell===e.target){
        if(e.key==='Escape'){e.preventDefault();closeSheetPicker();return}
        if(e.key==='Enter'){e.preventDefault();chooseSheetPicker(sheetPicker.active);return}
        if(e.key==='ArrowUp'||e.key==='ArrowDown'){
          e.preventDefault();
          if(sheetPicker.options.length){
            sheetPicker.active=Math.max(0,Math.min(sheetPicker.options.length-1,sheetPicker.active+(e.key==='ArrowUp'?-1:1)));
            markSheetPicker();
          }
          return;
        }
        if(e.key==='Home'||e.key==='End'){
          e.preventDefault();sheetPicker.active=e.key==='Home'?0:sheetPicker.options.length-1;markSheetPicker();return;
        }
        if(e.key==='Tab'){closeSheetPicker();return}
        if(e.key==='ArrowLeft'||e.key==='ArrowRight'){
          e.preventDefault();moveGrid(grid,row,col,0,e.key==='ArrowLeft'?-1:1);return;
        }
      }
      if(e.key==='Enter'){
        e.preventDefault();
        if(grid==='lotto')moveGrid(grid,row,col,e.shiftKey?-1:1,0);
        else if(pickable)openSheetPicker(e.target);
        // Sheet entry uses arrows for cell movement; Lotto keeps its existing Enter behavior.
        return;
      }
      if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();moveGrid(grid,row,col,e.key==='ArrowUp'?-1:1,0);return}
      if((e.key==='ArrowLeft'||e.key==='ArrowRight')&&
        (e.target.tagName==='SELECT'||(e.target.tagName==='INPUT'&&
         (e.key==='ArrowLeft'?e.target.selectionStart===0:e.target.selectionStart===e.target.value.length)))){
        e.preventDefault();moveGrid(grid,row,col,0,e.key==='ArrowLeft'?-1:1);return;
      }
    }
    if((e.ctrlKey||e.metaKey)&&e.key==='k'){e.preventDefault();editId=null;go('quick')}
    if(e.key==='Escape')document.querySelector('#sidebar').classList.remove('open');
  });
  window.addEventListener('storage',e=>{if(e.key===KEY){try{db=e.newValue?JSON.parse(e.newValue):empty();if(upgrade(db))save();render();toast('다른 탭에서 변경된 장부를 새로 불러왔습니다.')}catch(_){}}});
  if(location.hash.slice(1) in views)page=location.hash.slice(1);period='all';render();if(apiBase&&apiToken)void pullServer(true);
})();