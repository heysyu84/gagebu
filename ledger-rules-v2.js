/* Gagebu v2 — deterministic classification rules. No user financial data in this file. */
(function(global){
'use strict';
const ONLINE=/(?:쿠팡|쿠페이|G마켓|지마켓|11번가|11pay|네이버\s*(?:쇼핑|스토어|페이)|스마트스토어|알리익스프레스|aliexpress|테무|temu|옥션|auction|ssg|이베이|롯데온|오늘의집|무신사|마켓컬리|컬리|iherb|아이허브|인터파크|위메프|티몬|29cm)/i;
const CONVENIENCE=/(?:^cu\s|^cu-|^cu_|씨유|이마트24|emart24|gs25|세븐일레븐|7.?eleven|미니스톱|편의점)/i;
const DELIVERY=/(?:배달의민족|배민|요기요|쿠팡이츠|땡겨요|위메프오|배달특급)/i;
const DAISO=/(?:다이소|아성다이소)/i;
const TOTO=/(?:스포츠\s*토토|스포츠토토코리아|토토\s*당첨|토토코리아|토토\s*정산|베트맨\s*토토)/i;
const INVEST=/(?:증권|주식|투자|해외주식|ETF|코인|업비트|빗썸|미래에셋|키움|삼성증권|한국투자|토스증권|KB증권|신한투자)/i;
const PREPAID=/(?:온누리\s*충전|페이머니\s*충전|카카오페이\s*충전|토스머니\s*충전|선불금\s*충전)/i;
const CARD_SETTLEMENT=/(?:카드대금|카드결제대금|신용카드\s*결제|카드\s*출금|카드\s*자동납부)/i;
const GANGDONG=/(?:강동|둔촌|길동|성내|천호|암사|명일|고덕|상일|강일|올림픽공원\s*북|성일\s*동)/i;
const OUTSIDE=/(?:종로|종각|낙원|을지로|을지|광화문|청계|명동|동대문|신논현|강남|서초|홍대|합정|마포|연남|신촌|이태원|용산|성수|왕십리|광진|잠실|송파|가락|수유|신사|구로|영등포|여의도|혜화|안국|북촌|을지\s*\d|인사동)/i;
// Rent payees are private: never hardcode personal recipient names in public source.
const n=s=>String(s||'').replace(/\s+/g,'').toLocaleLowerCase('ko');
const matches=(value,re)=>re.test(String(value||''));
function location(text){
 const m=String(text||'');
 if(matches(m,GANGDONG))return 'gangdong';
 if(matches(m,OUTSIDE))return 'outside';
 return 'unknown';
}
function categoryFor(scope,major,minor,merchant){
 if(scope==='windmoon'){
   if(matches(merchant,DAISO))return ['풍월관','소모품'];
   if(matches(merchant,CONVENIENCE))return ['풍월관','편의점'];
   if(major==='식비'||major==='카페/간식')return ['풍월관','식비'];
   if(matches(merchant,ONLINE))return ['풍월관','온라인 구매'];
   return ['풍월관','운영 관련'];
 }
 if(scope==='business'){
   if(matches(merchant,ONLINE))return ['발주',merchant.includes('쿠팡')?'쿠팡':'온라인'];
   return ['가게','기타'];
 }
 if(major==='식비'||major==='카페/간식')return ['외식/배달',minor||''];
 if(matches(merchant,CONVENIENCE))return ['편의점',''];
 if(matches(merchant,ONLINE))return ['쇼핑','온라인'];
 if(major==='의료/건강')return ['병원/약국',''];
 if(major==='교통')return ['교통비',''];
 if(major==='생활'&&minor==='마트')return ['식재료',''];
 return ['기타',''];
}
function classification(scope,merchant,major,minor,reason,conf=1){
 const [category,subcategory]=categoryFor(scope,major,minor,merchant);
 const ledgerType=scope==='business'?'fixed':scope==='windmoon'?'consumption':'consumption';
 return {action:'keep',scope,status:'confirmed',ledgerType,category,subcategory,reason,confidence:conf};
}
function review(reason,merchant,major,minor,online=false){
 return {action:'keep',scope:'review',status:'review',ledgerType:'consumption',category:online?'온라인쇼핑':'미분류',subcategory:'',reason,confidence:0};
}
function skip(reason){return {action:'skip',reason}}
function classify(row,customRules={}){
 const m=String(row.merchant||'').trim(),detail=[m,row.major,row.minor,row.payment].join(' '),type=String(row.type||''),amount=Number(row.amount)||0;
 if(type==='수입'||amount>=0)return skip('수입·환급 내역 제외');
 if(matches(detail,INVEST)||row.major==='투자'||row.major==='저축')return skip('주식·투자·저축 거래 제외');
 if(matches(m,TOTO))return skip('토토 관련 입출금 제외');
 if(matches(m,PREPAID))return skip('온누리·페이머니 충전 — 실제 사용과 이중 집계 방지');
 if(matches(m,CARD_SETTLEMENT)||row.major==='카드대금')return skip('카드대금 이체 — 이중 집계 방지');
 // Transfers to known fixed payees are real rent expenses. Other personal transfers are
 // omitted from spending, because most are toto prize settlements rather than expenses.
 if(type==='이체'){
   return skip('개인 간 송금·계좌이체는 토토 정산 또는 자산이동 가능성이 높아 제외. 기존 시트의 월세·임대료는 따로 일치 확인');
 }
 if(type!=='지출')return skip('지출 유형이 아닌 거래');
 if(!m)return review('거래처 이름이 없어 확인 필요',m,row.major,row.minor);
 if(customRules[n(m)]){
   const c=customRules[n(m)];
   if(c.scope==='exclude')return skip('사용자 지정 제외 규칙');
   const item=classification(c.scope,m,row.major,row.minor,'사용자 지정 거래처 규칙');
   if(c.category)item.category=c.category;
   if(c.subcategory)item.subcategory=c.subcategory;
   if(c.ledgerType)item.ledgerType=c.ledgerType;
   return item;
 }
 if(matches(m,DAISO))return classification('windmoon',m,row.major,row.minor,'다이소 전 거래 풍월관');
 if(matches(m,ONLINE))return review('온라인 쇼핑: 개인 / 편의점 / 풍월관 선택',m,row.major,row.minor,true);
 if(matches(m,DELIVERY))return review('배달 주문은 지역 기준 풍월관 자동분류에서 제외',m,row.major,row.minor);
 if(matches(m,CONVENIENCE)){
   if(n(m).includes('cu둔촌점'))return classification('personal',m,row.major,row.minor,'CU 둔촌점은 풍월관 자동분류 예외');
   const loc=location(m);
   if(loc==='outside')return classification('windmoon',m,row.major,row.minor,'강동 외 편의점');
   if(loc==='gangdong')return classification('personal',m,row.major,row.minor,'강동 일대 편의점');
   return review('편의점 점포 위치 미확인',m,row.major,row.minor);
 }
 const isDining=['식비','카페/간식'].includes(row.major);
 if(isDining){
   const loc=location(m);
   if(loc==='outside')return classification('windmoon',m,row.major,row.minor,'강동 외 식당·카페');
   if(loc==='gangdong')return classification('personal',m,row.major,row.minor,'강동 일대 식당·카페');
   return review('식당·카페의 지점 위치 미확인',m,row.major,row.minor);
 }
 // Other location-sensitive charges should not be assumed to be Windmoon.
 if(matches(m,PREPAID))return skip('선불 충전');
 if(row.major==='의료/건강')return classification('personal',m,row.major,row.minor,'의료 관련 소비(재검토 가능)',0.8);
 if(row.major==='교통')return review('교통·출장 비용의 부담 주체 확인',m,row.major,row.minor);
 if(row.major==='금융'||row.major==='주거/통신')return review('고정지출·사업비·개인 지출 구분 확인',m,row.major,row.minor);
 if(row.major==='생활'&&row.minor==='마트')return classification('personal',m,row.major,row.minor,'일반 식재료 구매(재검토 가능)',0.75);
 return review('사용처를 확정할 근거 없음',m,row.major,row.minor);
}
function classifyChoice(scope,row){
 if(scope==='exclude')return {scope:'excluded',status:'excluded',reason:'사용자가 제외'};
 const item=classification(scope,row.merchant||'',row.bankMajor||row.major,row.bankMinor||row.minor,'사용자가 직접 분류');
 return {...item,manual:true};
}
global.GagebuRules={classify,classifyChoice,location,normalizeMerchant:n,patterns:{ONLINE,CONVENIENCE,DELIVERY,DAISO,TOTO,INVEST,PREPAID},categoryFor};
})(window);