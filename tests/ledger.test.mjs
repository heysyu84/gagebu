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
 const expose=`render=()=>{};toast=()=>{};globalThis.ledgerTest={get:()=>state,set:data=>{state={...blank(),...data};persistedState=JSON.stringify(state)},setRefund:id=>activeRefund=id,planSafeLedgerMerge,netExpenseAmount,financials,changeRefund,deleteRecordById,excludeRecord,restoreRecord,save};`;
 const source=file('ledger-v2.js');assert(source.endsWith('init();\n})();\n'));
 vm.runInContext(source.replace(/init\(\);\n\}\)\(\);\n$/,expose+'\n})();\n'),context);
 const api=context.ledgerTest;api.set(data);
 return {...api,storage:memory,fail:()=>{fail=true}};
}
test('manual partial refunds and FX differences offset the original expense month',()=>{
 const f=ledger({...empty(),records:[purchase()],refunds:[refund()]});f.setRefund('r');f.changeRefund('link','p');
 assert.equal(f.get().refunds[0].status,'matched');assert.equal(f.financials('2026-10').expenses,7000);
 assert.equal(f.financials('2026-11').income,0);assert.equal(f.financials('2026-11').expenses,0);
 f.get().refunds[0].amount=10100;assert.equal(f.netExpenseAmount(f.get().records[0]),-100);
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
