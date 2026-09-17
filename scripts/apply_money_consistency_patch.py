from pathlib import Path

APP=Path('app.js')
SERVER=Path('server/worker.js')
app=APP.read_text(encoding='utf-8')
server=SERVER.read_text(encoding='utf-8')


def once(src,old,new,label):
    n=src.count(old)
    if n!=1:
        raise SystemExit(f'{label}: expected 1 match, got {n}')
    return src.replace(old,new,1)

# ---- app: 所定労働時間を警告表示にも統一 ----
app=once(app,
'''  const hourly=Math.round(wage/8);
  if(hourly<MIN_HOURLY)
    return confirm(`${label} ${yen(wage)} は、8時間で割ると時給 ${yen(hourly)} です。\\n`+''',
'''  const H=workHours();
  const hourly=Math.round(wage/H);
  if(hourly<MIN_HOURLY)
    return confirm(`${label} ${yen(wage)} は、${H}時間で割ると時給 ${yen(hourly)} です。\\n`+''',
'wage sanity workHours')

# ---- app: 一括入力も通常入力と同じ車代初期値ルール ----
app=once(app,
'''      if((rec.attendance||0)===0){
        rec.attendance=1;n++;
        if(jpHoliday(d.getFullYear(),d.getMonth()+1,d.getDate()))nHol++;
      }''',
'''      if((rec.attendance||0)===0){
        const applyDefaultTransport=shouldApplyDefaultTransport(rec,'attendance',1);
        rec.attendance=1;
        if(applyDefaultTransport){
          const def=safeNum(STATE.settings.defaultTransportFee,INPUT_MAX.transportFee);
          if(def>0)rec.transportFee=def;
        }
        n++;
        if(jpHoliday(d.getFullYear(),d.getMonth()+1,d.getDate()))nHol++;
      }''',
'bulk default transport')

# ---- app: 判子欄は既存の朱色二重枠を保ち、会社名だけ消す ----
seal_start=app.find('function buildSeal(){')
seal_end=app.find('/* 発行の瞬間に角印を押す */',seal_start)
if seal_start<0 or seal_end<0:
    raise SystemExit('seal bounds missing')
seal='''function buildSeal(){
  // 実際の判子を押す位置だけ示す。会社名は印影として自動描画しない。
  return `<svg class="seal" viewBox="0 0 100 100" aria-label="押印欄">
    <rect x="3" y="3" width="94" height="94" rx="5" fill="rgba(255,255,255,.35)" stroke="#c0392b" stroke-width="5"/>
    <rect x="9.5" y="9.5" width="81" height="81" rx="3" fill="none" stroke="#c0392b" stroke-width="1.4"/>
  </svg>`;
}
'''
app=app[:seal_start]+seal+app[seal_end:]
app=app.replace('/* 角印風の印影を会社名から組む。発行の瞬間に「ポン」と押される演出に使う。\n   （次回の電子印鑑機能でも同じ描画を流用できる形にしてある） */\n','/* 請求書の押印位置。会社名入りの自動印影は作らない。 */\n',1)
app=app.replace('wrap.innerHTML=buildSeal(name);','wrap.innerHTML=buildSeal();',1)
app=app.replace('${buildSeal(issuer.companyName)}','${buildSeal()}',1)
app=app.replace('// 画面用の角印アニメーションとは別に、印刷/PDF側へも同じ印影を埋め込む。','// 印刷/PDF側にも同じ押印欄を置く。会社名は中へ描画しない。',1)

# ---- app: 1日1行に統合し、通常の最大31日を1人1枚に収める ----
start=app.find('  // A4 1枚に安全に収まる明細行数。')
end=app.find('    const chunks=[];',start)
if start<0 or end<0:
    raise SystemExit('detail-row block missing')
new_detail='''  // 1人の月次出面をA4 1枚にするため、日勤と夜勤が同日にあっても1日1行へ集約する。
  // 請求期間は最大31日なので、通常は1人につき31行＋合計行で1枚に収まる。
  const ROWS_PER_SHEET=31;
  const detailSheets=[];
  reports.forEach(({emp,rep})=>{
    const rowList=[];
    daysInPeriod(period.start,period.end).forEach(ds=>{
      const rec=rep.records.find(r=>r.date===ds);
      if(!rec)return;
      const t=dailyTotal(rec,emp);
      const d=new Date(ds+'T00:00:00');
      const dateLbl=`${d.getMonth()+1}/${d.getDate()}(${WEEK[d.getDay()]})`;
      if(t.overridden){
        rowList.push(`<tr><td class="inv-l">${dateLbl}</td><td class="inv-c">手動</td><td class="inv-c">—</td><td>${yen(t.total)}</td><td>—</td><td>—</td><td class="inv-bold">${yen(t.total)}</td></tr>`);
        return;
      }
      const att=safeNum(rec.attendance,INPUT_MAX.attendance);
      const natt=safeNum(rec.nightAttendance,INPUT_MAX.nightAttendance);
      const hasDay=att>0,hasNight=natt>0;
      if(!hasDay&&!hasNight&&t.tr<=0)return;
      const kind=[hasDay?'日勤':'',hasNight?'夜勤':''].filter(Boolean).join('・')||'—';
      const wage=t.wage+t.nwage;
      const ot=t.ot+t.not;
      rowList.push(`<tr><td class="inv-l">${dateLbl}</td><td class="inv-c">${kind}</td><td class="inv-c">${att+natt||0}</td><td>${yen(wage)}</td><td>${yen(ot)}</td><td>${yen(t.tr)}</td><td class="inv-bold">${yen(t.autoTotal)}</td></tr>`);
    });
'''
app=app[:start]+new_detail+app[end:]

# 出面31行用に印刷密度を安全側へ寄せる。
anchor="#print-root .inv-pay-slip-page .inv-p1-foot{bottom:5mm;left:12mm;right:12mm;}\n"
extra='''#print-root .inv-detail-page .inv-topbar{height:4mm;}
#print-root .inv-detail-page .inv-inner{padding:9mm 14mm 15mm;}
#print-root .inv-detail-page .inv-p2-title{font-size:13pt;margin-bottom:1mm;}
#print-root .inv-detail-page .inv-p2-sub{margin-bottom:3.5mm;padding-bottom:1.5mm;}
#print-root .inv-detail-page .inv-emp-block{margin-bottom:3mm;}
#print-root .inv-detail-page .inv-emp-block-title{margin-bottom:1.5mm;}
#print-root .inv-detail-page table.inv-detail{margin-bottom:2mm;}
#print-root .inv-detail-page table.inv-detail thead th{font-size:7pt;padding:0 1.5mm 1mm;}
#print-root .inv-detail-page table.inv-detail tbody td{font-size:7.2pt;line-height:1.15;padding:.9mm 1.5mm;}
#print-root .inv-detail-page .inv-detail .inv-total-row td{font-size:7.5pt;padding-top:1.2mm;}
#print-root .inv-detail-page .inv-p1-foot{bottom:5mm;left:14mm;right:14mm;}
'''
if anchor not in app:
    raise SystemExit('detail css anchor missing')
app=app.replace(anchor,anchor+extra,1)
APP.write_text(app,encoding='utf-8')

# ---- server: 本体と同じ日付別単価・所定時間・入力上限で管理画面を再計算 ----
insert_before='/* 実データを人が読める形で出す。JSONを落として開かなくても様子が分かるように */\n'
if insert_before not in server:
    raise SystemExit('server adminData anchor missing')
helpers='''/* レポート内の金額再計算もアプリ本体と同じ前提にする。 */
function reportNum(v, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return max != null && n > max ? max : n;
}
function reportWorkHours(settings) {
  const h = Number(settings && settings.workHours);
  return Number.isFinite(h) && h > 0 && h <= 24 ? h : 8;
}
function reportRatesOn(emp, date) {
  const h = emp && Array.isArray(emp.wageHistory) ? emp.wageHistory : null;
  if (!h || !h.length) return emp || {};
  let best = null;
  h.forEach(w => { if (w && w.from <= date && (!best || w.from > best.from)) best = w; });
  if (best) return best;
  return h.filter(Boolean).reduce((a, b) => a.from < b.from ? a : b, {});
}
function reportDailyTotal(r, emp, settings) {
  const rate = reportRatesOn(emp, String(r && r.date || '9999-12-31'));
  const day = reportNum(rate && rate.dailyWage, 1000000);
  const night = reportNum(rate && rate.nightWage, 1000000);
  const a = reportNum(r && r.attendance, 3), na = reportNum(r && r.nightAttendance, 3);
  const oh = a > 0 ? reportNum(r && r.overtimeHours, 24) : 0;
  const nh = na > 0 ? reportNum(r && r.nightOvertimeHours, 24) : 0;
  const tr = Math.round(reportNum(r && r.transportFee, 100000));
  const H = reportWorkHours(settings);
  const auto = Math.round(day * a) + Math.round(day / H * 1.25 * oh)
    + Math.round(night * na) + Math.round(night / H * 1.25 * nh) + tr;
  const manual = reportNum(r && r.manualTotal, 10000000);
  return { a, na, oh, nh, tr, total: manual > 0 ? Math.round(manual) : auto };
}

'''
server=server.replace(insert_before,helpers+insert_before,1)

old='''  const emps = Array.isArray(d.employees) ? d.employees : [];
  const recs = canonicalRecords(d.records);
  const byId = new Map(emps.map(e => [e.id, e]));

  // 月ごとに、誰が何日出て請求がいくらになったかをまとめる
  const months = new Map();
  recs.forEach(r => {
    const ym = String(r.date || '').slice(0, 7);
    if (!ym) return;
    if (!months.has(ym)) months.set(ym, new Map());
    const per = months.get(ym);
    const e = byId.get(r.employeeId);
    const nm = e ? e.name : '（削除済み）';
    const cur = per.get(nm) || { att: 0, ot: 0, tr: 0, total: 0 };
    const day = Number(e && e.dailyWage) || 0, night = Number(e && e.nightWage) || 0;
    const a = Number(r.attendance) || 0, na = Number(r.nightAttendance) || 0;
    const oh = a > 0 ? (Number(r.overtimeHours) || 0) : 0;
    const nh = na > 0 ? (Number(r.nightOvertimeHours) || 0) : 0;
    const tr = Number(r.transportFee) || 0;
    const man = Number(r.manualTotal) || 0;
    const auto = Math.round(day * a) + Math.round(day / 8 * 1.25 * oh)
      + Math.round(night * na) + Math.round(night / 8 * 1.25 * nh) + Math.round(tr);
    cur.att += a + na; cur.ot += oh + nh; cur.tr += tr;
    cur.total += man > 0 ? Math.round(man) : auto;
    per.set(nm, cur);
  });
  const ms = [...months.keys()].sort().reverse().slice(0, 12);

  const s = d.settings || {};'''
new='''  const emps = Array.isArray(d.employees) ? d.employees : [];
  const recs = canonicalRecords(d.records);
  const byId = new Map(emps.map(e => [e.id, e]));
  const s = d.settings || {};

  // 月ごとに、誰が何日出て請求がいくらになったかをまとめる。
  // 単価履歴と所定労働時間も本体と同じ条件で再現する。
  const months = new Map();
  recs.forEach(r => {
    const ym = String(r.date || '').slice(0, 7);
    if (!ym) return;
    if (!months.has(ym)) months.set(ym, new Map());
    const per = months.get(ym);
    const e = byId.get(r.employeeId);
    const nm = e ? e.name : '（削除済み）';
    const cur = per.get(nm) || { att: 0, ot: 0, tr: 0, total: 0 };
    const t = reportDailyTotal(r, e, s);
    cur.att += t.a + t.na; cur.ot += t.oh + t.nh; cur.tr += t.tr;
    cur.total += t.total;
    per.set(nm, cur);
  });
  const ms = [...months.keys()].sort().reverse().slice(0, 12);'''
server=once(server,old,new,'server admin calculation')
SERVER.write_text(server,encoding='utf-8')

# ---- regression tests ----
test=r'''"use strict";
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
'''
Path('tests/money-consistency-hardening.test.js').write_text(test,encoding='utf-8')

for tmp in [Path('scripts/apply_money_consistency_patch.py'),Path('.github/workflows/apply-money-consistency.yml')]:
    if tmp.exists():tmp.unlink()
