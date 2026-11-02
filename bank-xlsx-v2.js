/* Gagebu v2 / BankSalad XLSX reader — runs entirely in browser, no network upload. */
(function(global){
'use strict';
const ns='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function xml(text){
 const d=new DOMParser().parseFromString(text,'application/xml');
 if(d.querySelector('parsererror'))throw Error('엑셀 XML을 읽을 수 없습니다.');
 return d;
}
const nodes=(node,tag)=>Array.from(node.getElementsByTagName(tag));
const colNumber=addr=>{let a=0;for(const ch of (addr.match(/^[A-Z]+/)||[''])[0])a=a*26+ch.charCodeAt(0)-64;return a-1};
function excelDate(value){
 if(typeof value==='number'||(/^\d{5}(?:\.\d+)?$/.test(String(value)))) {
   const d=new Date(Date.UTC(1899,11,30)+Math.floor(Number(value))*86400000);
   return d.toISOString().slice(0,10);
 }
 const s=String(value||'').trim().replace(/[./]/g,'-');
 const match=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
 const date=match?match[1]+'-'+match[2].padStart(2,'0')+'-'+match[3].padStart(2,'0'):'';
 return global.GagebuValidation?.date(date)?date:'';
}
function timeStr(v){
 if(!v)return '';
 const x=Number(v);
 if(!Number.isFinite(x))return String(v);
 const minutes=Math.round((x-Math.floor(x))*24*60);
 return String(Math.floor(minutes/60)%24).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0');
}
async function parseBankSalad(file){
 if(!global.JSZip)throw Error('엑셀 처리 모듈을 읽지 못했습니다.');
 if(!file||!/\.xlsx$/i.test(file.name))throw Error('뱅크샐러드 .xlsx 파일을 선택해 주세요.');
 if(file.size>30*1024*1024)throw Error('30MB 이하의 엑셀 파일만 처리할 수 있습니다.');
 const zip=await global.JSZip.loadAsync(file);
 const get=async path=>zip.file(path)?await zip.file(path).async('string'):null;
 const wb=xml(await get('xl/workbook.xml')||'');
 const relDoc=xml(await get('xl/_rels/workbook.xml.rels')||'');
 const relationships={};
 for(const rel of nodes(relDoc,'Relationship'))relationships[rel.getAttribute('Id')]=rel.getAttribute('Target');
 const sheet=nodes(wb,'sheet').find(x=>x.getAttribute('name')==='가계부 내역')||nodes(wb,'sheet').find(x=>x.getAttribute('name')==='가계부내역');
 if(!sheet)throw Error('시트 이름이 "가계부 내역"인 뱅크샐러드 원본 파일이 필요합니다.');
 const rid=sheet.getAttributeNS(ns,'id')||sheet.getAttribute('r:id');
 const target=relationships[rid];
 if(!target)throw Error('거래내역 시트 경로가 없습니다.');
 const absolute=target.replace(/^\//,'');
 const path=absolute.startsWith('xl/')?absolute:'xl/'+absolute.replace(/^\.\//,'');
 const sheetXml=await get(path);
 if(!sheetXml)throw Error('거래내역 시트를 열 수 없습니다.');
 const strings=[];
 const text=await get('xl/sharedStrings.xml');
 if(text){
   const d=xml(text);
   for(const si of nodes(d,'si'))strings.push(nodes(si,'t').map(n=>n.textContent||'').join(''));
 }
 const d=xml(sheetXml),out=[],head=[];
 const rows=nodes(d,'row');
 for(const row of rows){
   const cols=[];
   for(const c of Array.from(row.children).filter(x=>x.localName==='c')){
     const i=colNumber(c.getAttribute('r')||'');
     if(i<0||i>15)continue;
     const ty=c.getAttribute('t');
     let raw=Array.from(c.children).find(x=>x.localName==='v')?.textContent;
     if(ty==='s')raw=strings[Number(raw)]||'';
     else if(ty==='inlineStr')raw=nodes(c,'t').map(x=>x.textContent||'').join('');
     else if(raw!==undefined&&raw!==null&&/^-?\d+(?:\.\d+)?$/.test(raw))raw=Number(raw);
     cols[i]=raw??'';
   }
   if(!head.length){head.push(...cols);continue}
   const date=excelDate(cols[0]);
   if(!date)continue;
   const merchant=String(cols[5]??'').trim();
   const amount=Number(String(cols[6]??0).replace(/,/g,''));
   if(!Number.isFinite(amount))continue;
   out.push({date,time:timeStr(cols[1]),type:String(cols[2]||''),major:String(cols[3]||''),minor:String(cols[4]||''),merchant,amount,payment:String(cols[8]||''),memo:String(cols[9]||''),bankRow:Number(row.getAttribute('r'))||0});
 }
 if(!head.includes('날짜')||!head.includes('내용')||!head.includes('금액')||!head.includes('결제수단'))throw Error('거래내역 엑셀의 열 구조가 다릅니다. 원본 뱅크샐러드 파일인지 확인해 주세요.');
 return {rows:out,headers:head,fileName:file.name};
}
global.BankSaladXLSX={parseBankSalad};
})(window);
