"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');

const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
function extract(src,name){
  const start=src.indexOf(`function ${name}(`);assert.ok(start>=0,`${name} missing`);
  const open=src.indexOf('{',start);let depth=0;
  for(let i=open;i<src.length;i++){
    if(src[i]==='{')depth++; else if(src[i]==='}'&&--depth===0)return src.slice(start,i+1);
  }
  throw new Error(`${name} unclosed`);
}

test('日給の時給換算警告も設定した所定労働時間を使う',()=>{
  let confirmed=0;
  const ctx={WAGE_SANE_MAX:60000,MIN_HOURLY:1075,workHours:()=>7.5,
    confirm:()=>{confirmed++;return true;},yen:n=>'¥'+n};ctx.globalThis=ctx;vm.createContext(ctx);
  vm.runInContext(extract(app,'wageLooksSane')+';globalThis.fn=wageLooksSane;',ctx);
  assert.equal(ctx.fn('日給',8250),true);
  assert.equal(confirmed,0,'7.5時間なら時給1100円なので最低賃金警告を出さない');
});

test('平日の一括入力でも通常入力と同じ既定車代を入れる',()=>{
  const ctx={selEmp:'e1',viewY:2026,viewM:9,STATE:{records:[],settings:{defaultTransportFee:1350}},
    logUse(){},daysInMonthList:()=>['2026-09-17'],recordForDay:()=>null,uid:()=> 'r1',
    shouldApplyDefaultTransport:()=>true,safeNum:v=>Number(v)||0,INPUT_MAX:{transportFee:100000},
    jpHoliday:()=>'',saveRecords(){},haptic(){},renderAtt(){},toast(){},confirm:()=>true,Date};
  ctx.globalThis=ctx;vm.createContext(ctx);
  vm.runInContext(extract(app,'bulkFill')+';globalThis.fn=bulkFill;',ctx);
  ctx.fn('weekday');
  assert.equal(ctx.STATE.records.length,1);
  assert.equal(ctx.STATE.records[0].attendance,1);
  assert.equal(ctx.STATE.records[0].transportFee,1350);
});

test('月次出面は日勤と夜勤を同日1行にまとめ最大31日を1枚単位にする',()=>{
  const start=app.indexOf('const ROWS_PER_SHEET=31;');
  const end=app.indexOf('const chunks=[];',start);
  assert.ok(start>=0&&end>start);
  const block=app.slice(start,end);
  assert.equal((block.match(/rowList\.push/g)||[]).length,2,'通常行と手動行の2系統だけにする');
  assert.match(block,/t\.wage\+t\.nwage/);
  assert.match(block,/t\.ot\+t\.not/);
  assert.match(app,/\.inv-detail-page table\.inv-detail tbody td\{font-size:7\.2pt;line-height:1\.15;padding:\.9mm 1\.5mm;\}/);
});

const workerSource=fs.readFileSync(path.join(__dirname,'..','server','worker.js'),'utf8');
const runnable=workerSource.replace('export default {','globalThis.__worker = {');
const wctx={console,Date,Math,JSON,Map,Set,String,Number,Array,Object,Promise,TextEncoder,Uint8Array,
  URL,Request,Response,Headers,FormData,crypto:webcrypto};wctx.globalThis=wctx;vm.createContext(wctx);
vm.runInContext(runnable,wctx,{filename:'worker.js'});

test('管理画面の月次請求も単価履歴と7.5時間設定を再現する',async()=>{
  const data={
    employees:[{id:'e1',name:'A',dailyWage:24000,nightWage:0,wageHistory:[
      {from:'0000-01-01',dailyWage:18000,nightWage:0},{from:'2026-08-15',dailyWage:21000,nightWage:0}]}],
    records:[
      {id:'r1',employeeId:'e1',date:'2026-08-10',attendance:1,overtimeHours:1,nightAttendance:0,nightOvertimeHours:0,transportFee:0},
      {id:'r2',employeeId:'e1',date:'2026-08-20',attendance:1,overtimeHours:1,nightAttendance:0,nightOvertimeHours:0,transportFee:0}],
    settings:{workHours:7.5,closingDay:31,taxRate:10,defaultTransportFee:0,issuer:{},client:{},bank:{}},invoiceLog:[]};
  const stored=JSON.stringify({id:'case',at:Date.now(),device:'dev',version:'test',data});
  const env={ADMIN_KEY:'admin-secret',REPORTS:{async get(k){return k==='r:case'?stored:null;},async list(){return {keys:[]};}}};
  const res=await wctx.__worker.fetch(new Request('https://reports.example/admin/data?id=case',{headers:{Cookie:'invoice_admin=admin-secret'}}),env);
  assert.equal(res.status,200);
  const html=await res.text();
  assert.match(html,/2026-08<\/b> 合計 ¥45,500/);
});
