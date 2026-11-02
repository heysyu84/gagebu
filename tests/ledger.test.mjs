import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';

const file=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const purchase=(id='p',amount=10000)=>({id,date:'2026-10-25',amount,direction:'expense',scope:'personal',status:'confirmed',merchant:'검증용 상점',payment:'카드',ledgerType:'consumption',category:'생활',subcategory:'기타'});
const empty=()=>({version:2,records:[],dailyLotto:[],storeProfits:{},refunds:[]});
const refund=(id='r')=>({id,date:'2026-11-02',amount:3000,status:'review',refundOf:'',merchant:'검증용 상점',payment:'카드'});
function ledger(data=empty()){
 let fail=false;const memory=new Map();
 const ui={close(){},classList:{add(){},remove(){}},setAttribute(){},closest(){return this}};
 const context=vm.createContext({crypto:webcrypto,TextEncoder,Date,URL,Blob,console,
  localStorage:{getItem:key=>memory.get(key)??null,setItem:(key,value)=>{if(fail)throw Error('quota');memory.set(key,value)}},
  document:{querySelector:()=>ui,querySelectorAll:()=>[]},confirm:()=>true,setTimeout,clearTimeout});
 context.window=context;
 for(const script of ['ledger-validation.js','ledger-rules-v2.js'])vm.runInContext(file(script),context);
 const expose=`render=()=>{};toast=()=>{};globalThis.ledgerTest={get:()=>state,set:data=>{state={...blank(),...data};persistedState=JSON.stringify(state)},setRefund:id=>activeRefund=id,setView:options=>{page=options.page||'records';period=options.period||'all';scopeFilter=options.scope||'all';typeFilter=options.type||'all';paymentFilter=options.payment||'all';q=options.query||'';recordsMode=options.mode||'active'},planSafeLedgerMerge,netExpenseAmount,financials,refundEntries,ledgerEntries,filtered,recordsPage,dashboard,transactionTable,transactionCSV,changeRefund,deleteRecordById,excludeRecord,restoreRecord,save};`;
 const source=file('ledger-v2.js');assert(source.endsWith('init();\n})();\n'));
 vm.runInContext(source.replace(/init\(\);\n\}\)\(\);\n$/,expose+'\n})();\n'),context);
 const api=context.ledgerTest;api.set(data);
 return {...api,storage:memory,fail:()=>{fail=true}};
}
test('partial refunds use their own date and linking never deducts them twice',()=>{
 const f=ledger({...empty(),records:[purchase()],refunds:[refund()]});
 assert.equal(f.financials('2026-10').expenses,10000);
 assert.equal(f.financials('2026-11').income,0);assert.equal(f.financials('2026-11').expenses,-3000);
 assert.equal(f.financials('all').expenses,7000);
 f.setRefund('r');f.changeRefund('link','p');
 assert.equal(f.get().refunds[0].status,'matched');assert.equal(f.netExpenseAmount(f.get().records[0]),7000);
 assert.equal(f.financials('2026-10').expenses,10000);assert.equal(f.financials('2026-11').expenses,-3000);
 assert.equal(f.financials('all').expenses,7000);
 f.changeRefund('unlink');assert.equal(f.financials('all').expenses,7000);
 f.get().refunds[0].amount=10100;f.changeRefund('link','p');
 assert.equal(f.netExpenseAmount(f.get().records[0]),-100);
 assert.equal(f.financials('all').expenses,-100);assert.equal(f.financials('2026-11').expenses,-10100);
});
test('multiple partial refunds are independent credits and exclusion restores correctly',()=>{
 const f=ledger({...empty(),records:[purchase()],refunds:[refund(),{...refund('second'),date:'2026-12-04',amount:4000,status:'matched',refundOf:'p'}]});
 assert.equal(f.financials('all').expenses,3000);
 assert.equal(f.financials('2026-11').expenses,-3000);assert.equal(f.financials('2026-12').expenses,-4000);
 f.setRefund('r');f.changeRefund('exclude');
 assert.equal(f.financials('2026-11').expenses,0);assert.equal(f.financials('all').expenses,6000);
 f.changeRefund('restore');assert.equal(f.financials('all').expenses,3000);
});
test('a refund without a purchase appears in the ledger without creating stored transactions',()=>{
 const f=ledger({...empty(),refunds:[refund()]}),before=JSON.stringify(f.get());
 const entries=f.ledgerEntries();assert.equal(entries.length,1);assert.equal(entries[0].date,'2026-11-02');
 assert.equal(entries[0].amount,-3000);assert.equal(entries[0].category,'환불');assert.equal(entries[0].scope,'refund-unassigned');
 const html=f.transactionTable(entries);assert.match(html,/\+3,000원/);assert.match(html,/원결제 미연결/);assert.match(html,/data-manage-refund="r"/);
 assert.equal(f.financials('2026-11').expenses,-3000);assert.equal(f.financials('2026-11').balance,3000);
 assert.equal(JSON.stringify(f.get()),before);
});
test('refund date, payment and refund-only filters match the displayed net total',()=>{
 const f=ledger({...empty(),records:[purchase()],refunds:[{...refund(),status:'matched',refundOf:'p'},{...refund('unlinked'),amount:2000},{...refund('excluded'),status:'excluded',amount:500}]});
 f.setView({period:'2026-11',type:'refund',payment:'카드'});
 assert.equal(f.filtered(f.ledgerEntries()).length,3);
 const html=f.recordsPage();assert.match(html,/순지출 -5,000원/);assert.match(html,/전체 지출 · 환불/);assert.match(html,/금액 반영됨/);
 f.setView({period:'2026-11',scope:'personal'});assert.equal(f.filtered(f.ledgerEntries()).length,1);
 f.setView({period:'2026-11',scope:'refund-unassigned'});assert.equal(f.filtered(f.ledgerEntries()).length,2);
 f.setView({period:'2026-10',type:'refund'});assert.equal(f.filtered(f.ledgerEntries()).length,0);
});
test('CSV expense postings add to the same total including unlinked and excluded refunds',()=>{
 const f=ledger({...empty(),records:[purchase(),{...purchase('excluded'),amount:20000,status:'excluded'}],refunds:[refund(),{...refund('excluded-refund'),amount:500,status:'excluded'}]});
 const lines=f.transactionCSV().replace(/^\uFEFF/,'').split('\r\n');
 const parse=line=>[...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(m=>m[1].replaceAll('""','"'));
 const [header,...rows]=lines.map(parse);const amount=header.indexOf('지출 반영액'),kind=header.indexOf('항목');
 assert.equal(rows.length,4);assert.equal(rows.reduce((sum,row)=>sum+Number(row[amount]),0),f.financials('all').expenses);
 const credit=rows.find(row=>row[kind]==='환불'&&row[amount]==='-3000');assert(credit);assert.equal(credit[0],'2026-11-02');
 assert.equal(credit[header.indexOf('원결제 연결상태')],'미연결');
});
test('refund-only months render in the dashboard with an explicit credit total',()=>{
 const f=ledger({...empty(),records:[purchase()],refunds:[refund()]});f.setView({page:'dashboard',period:'2026-11'});
 const html=f.dashboard();assert.match(html,/환불 1건/);assert.match(html,/-3,000원/);assert.match(html,/사용처 미지정 환불 1건/);
 assert.match(html,/class="expense refund"/);assert(!html.includes('NaN'));assert(!html.includes('Infinity'));
});
test('deleting a purchase keeps its refund in review instead of leaving an orphan link',()=>{
 const f=ledger({...empty(),records:[purchase()],refunds:[{...refund(),status:'matched',refundOf:'p'}]});
 assert(f.deleteRecordById('p',false));assert.equal(f.get().refunds.length,1);
 assert.equal(f.get().refunds[0].status,'review');assert.equal(f.get().refunds[0].refundOf,null);
});
test('excluded records can be restored and do not affect totals while excluded',()=>{
 const f=ledger({...empty(),records:[purchase()]});f.excludeRecord('p');assert.equal(f.financials('all').expenses,0);
 f.restoreRecord('p');assert.equal(f.get().records[0].scope,'personal');assert.equal(f.financials('all').expenses,10000);
});
test('pristine restore retains refund IDs without bank keys and the import history',()=>{
 const f=ledger();const incoming={...empty(),records:[purchase()],refunds:[{...refund(),status:'matched',refundOf:'p'}],imports:[{name:'old-import.xlsx'}]};
 const plan=f.planSafeLedgerMerge(f.get(),incoming);
 assert.equal(plan.refundsAdded,1);assert.equal(plan.next.refunds[0].id,'r');assert.equal(plan.next.imports[0].name,'old-import.xlsx');
});
test('merging an older backup preserves newer edits and demotes unresolved refund links',()=>{
 const f=ledger({...empty(),records:[purchase('current')],imports:[{name:'recent.xlsx'}]});
 const incoming={...empty(),records:[purchase('older-id')],refunds:[{...refund(),status:'matched',refundOf:'older-id'}]};
 const plan=f.planSafeLedgerMerge(f.get(),incoming);
 assert.equal(plan.added,0);assert.equal(plan.duplicates,1);assert.equal(plan.next.records[0].id,'current');
 assert.equal(plan.next.refunds[0].status,'review');assert.equal(plan.next.imports[0].name,'recent.xlsx');
});
test('malformed backup settings are rejected before modifying the current ledger',()=>{
 const f=ledger({...empty(),records:[purchase()]});
 for(const extra of [{taxonomy:{consumption:{생활:'invalid'}}},{paymentMethods:[{}]},{records:[{...purchase(),date:'2026-02-30'}]}]){
  assert.throws(()=>f.planSafeLedgerMerge(f.get(),{...empty(),...extra}));
 }
 assert.equal(f.get().records[0].id,'p');
});
test('local storage failure and invalid changes roll back to the last saved ledger',()=>{
 const f=ledger({...empty(),records:[purchase()]});f.get().records[0].amount=20000;f.fail();
 assert.equal(f.save(),false);assert.equal(f.get().records[0].amount,10000);
 const g=ledger({...empty(),records:[purchase()]});g.get().records[0].amount=-1;
 assert.equal(g.save(),false);assert.equal(g.get().records[0].amount,10000);
});
