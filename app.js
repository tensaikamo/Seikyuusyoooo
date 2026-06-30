'use strict';
/* =============================================================
   日給管理・請求書 — iPhone単一HTML版（依存ゼロ）
   ネイビー×白 / IndexedDB / A4 2ページPDF
   ============================================================= */
const APP_VERSION='1.1.0';

/* ---------- HTML escape ---------- */
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

/* ---------- IndexedDB (kv) ---------- */
const DB='salary-db',STORE='kv';let _dbp=null;
function db(){if(_dbp)return _dbp;_dbp=new Promise((res,rej)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(STORE))r.result.createObjectStore(STORE);};r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});return _dbp;}
function idbGet(k){return db().then(d=>new Promise((res,rej)=>{const r=d.transaction(STORE,'readonly').objectStore(STORE).get(k);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);}));}
function idbSet(k,v){return db().then(d=>new Promise((res,rej)=>{const t=d.transaction(STORE,'readwrite');t.objectStore(STORE).put(v,k);t.oncomplete=()=>res();t.onerror=()=>rej(t.error);}));}
function idbClear(){return db().then(d=>new Promise((res,rej)=>{const t=d.transaction(STORE,'readwrite');t.objectStore(STORE).clear();t.oncomplete=()=>res();t.onerror=()=>rej(t.error);}));}

/* ---------- id ---------- */
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,8);}

/* ---------- STATE ---------- */
const WEEK=['日','月','火','水','木','金','土'];
const DEFAULT_SETTINGS={
  defaultTransportFee:1000,taxRate:10,closingDay:31,
  issuer:{companyName:'',postalCode:'',address:'',phone:'',invoiceNumber:''},
  client:{companyName:'',postalCode:'',address:'',contactName:''},
  bank:{bankName:'',branchName:'',accountType:'普通',accountNumber:'',accountHolder:''}
};
let STATE={
  employees:[],      // {id,name,dailyWage,nightWage,createdAt}
  records:[],        // {id,employeeId,date,attendance,overtimeHours,nightAttendance,nightOvertimeHours,transportFee,note}
  settings:JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
  ready:false
};
let viewY=new Date().getFullYear(), viewM=new Date().getMonth()+1; // 1-12
let selEmp=null;       // 勤怠タブで選択中のemployeeId
let nightExpanded=new Set(); // その月で夜勤欄を開いている日付
let billY=new Date().getFullYear(), billM=new Date().getMonth()+1; // 請求タブの請求月
let editEmpId=null;    // モーダル編集対象

const saveEmployees=()=>idbSet('employees',STATE.employees);
const saveRecords=()=>idbSet('records',STATE.records);
const saveSettings=()=>idbSet('settings',STATE.settings);
const saveReady=()=>idbSet('ready',STATE.ready);

/* ---------- utils ---------- */
function $(id){return document.getElementById(id);}
function toast(m){const e=$('toast');e.textContent=m;e.classList.add('show');clearTimeout(e._t);e._t=setTimeout(()=>e.classList.remove('show'),2200);}
function yen(n){return '¥'+Math.round(n||0).toLocaleString('ja-JP');}
function pad2(n){return String(n).padStart(2,'0');}
function ymd(y,m,d){return `${y}-${pad2(m)}-${pad2(d)}`;}
function fmtDateJ(s){const d=new Date(s+'T00:00:00');return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;}

/* ---------- calculations（元アプリと同一ロジック）---------- */
function overtimeRate(wage){return wage/8*1.25;}
/** 1日の合計。日勤(昼)＋夜勤(夜)＋車代。
 *  emp.dailyWage … 日勤の日給 / emp.nightWage … 夜勤の夜間単価（未設定なら0）
 *  rec.attendance/overtimeHours … 日勤の出勤数/残業h
 *  rec.nightAttendance/nightOvertimeHours … 夜勤の出勤数/残業h */
function dailyTotal(rec,emp){
  // 後方互換: 第2引数に数値(dailyWage)が渡された場合も動くようにする
  const dayWage=(typeof emp==='number')?emp:((emp&&emp.dailyWage)||0);
  const nightWage=(typeof emp==='number')?0:((emp&&emp.nightWage)||0);
  // 日勤
  const wage=Math.round(dayWage*(rec.attendance||0));
  const ot=Math.round(overtimeRate(dayWage)*(rec.overtimeHours||0));
  // 夜勤
  const nwage=Math.round(nightWage*(rec.nightAttendance||0));
  const not=Math.round(overtimeRate(nightWage)*(rec.nightOvertimeHours||0));
  const tr=Math.round(rec.transportFee||0);
  const total=wage+ot+nwage+not+tr;
  return {wage,ot,nwage,not,tr,total};
}
/** その記録に何か入力があるか（夜勤だけの日も拾う）*/
function recHasData(r){
  return (r.attendance||0)>0||(r.overtimeHours||0)>0||
         (r.nightAttendance||0)>0||(r.nightOvertimeHours||0)>0||
         (r.transportFee||0)>0;
}
function daysInMonthList(y,m){const out=[];const d=new Date(y,m-1,1);while(d.getMonth()===m-1){out.push(ymd(d.getFullYear(),d.getMonth()+1,d.getDate()));d.setDate(d.getDate()+1);}return out;}
function daysInPeriod(start,end){const out=[];const c=new Date(start+'T00:00:00'),e=new Date(end+'T00:00:00');while(c<=e){out.push(ymd(c.getFullYear(),c.getMonth()+1,c.getDate()));c.setDate(c.getDate()+1);}return out;}

/** 締め日から請求期間を計算（closingDay>=29は月末締め） */
function billingPeriod(year,month,closingDay){
  const monthEnd=closingDay>=29;
  let start,end;
  if(monthEnd){
    start=new Date(year,month-1,1);
    end=new Date(year,month,0);
  }else{
    let py=year,pm=month-1; if(pm===0){pm=12;py=year-1;}
    const prevLast=new Date(py,pm,0).getDate();
    const sd=Math.min(closingDay+1,prevLast);
    start=new Date(py,pm-1,sd);
    const curLast=new Date(year,month,0).getDate();
    const ed=Math.min(closingDay,curLast);
    end=new Date(year,month-1,ed);
  }
  const iso=d=>ymd(d.getFullYear(),d.getMonth()+1,d.getDate());
  const j=d=>`${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
  return {start:iso(start),end:iso(end),label:`${j(start)}〜${j(end)}`,periodLabel:`${year}年${month}月分`};
}
function calcTax(sub,rate){return Math.floor(sub*(rate/100));}

/** 期間レポート（従業員1人）*/
function periodReport(emp,start,end){
  const recs=STATE.records.filter(r=>r.employeeId===emp.id&&r.date>=start&&r.date<=end&&recHasData(r));
  let att=0,natt=0,wage=0,ot=0,nwage=0,not=0,tr=0;
  recs.forEach(r=>{
    const t=dailyTotal(r,emp);
    att+=r.attendance||0;
    natt+=r.nightAttendance||0;
    wage+=t.wage; ot+=t.ot; nwage+=t.nwage; not+=t.not; tr+=t.tr;
  });
  return {employeeId:emp.id,
    totalAttendance:att, totalNightAttendance:natt,
    totalDailyWage:wage, totalOvertimePay:ot,
    totalNightWage:nwage, totalNightOvertimePay:not,
    totalTransportFee:tr,
    grandTotal:wage+ot+nwage+not+tr, records:recs};
}

/* ---------- BOOT ---------- */
window.addEventListener('load',boot);
async function boot(){
  try{if(navigator.storage&&navigator.storage.persist){if(!(await navigator.storage.persisted()))await navigator.storage.persist();}}catch(e){}
  try{
    const [emps,recs,set,ready]=await Promise.all([idbGet('employees'),idbGet('records'),idbGet('settings'),idbGet('ready')]);
    if(emps)STATE.employees=emps;
    if(recs)STATE.records=recs;
    if(set)STATE.settings=mergeSettings(set);
    if(ready)STATE.ready=ready;
    if(!ready) await migrate();
  }catch(e){toast('⚠️ データ読込エラー');}
  if('serviceWorker'in navigator){try{await navigator.serviceWorker.register('sw.js');}catch(e){}}
  $('ver').textContent=APP_VERSION;
  buildClosingOptions();
  loadSettingsForm();
  if(STATE.employees.length) selEmp=STATE.employees[0].id;
  setTimeout(()=>$('splash').classList.add('hide'),700);
  renderAll();
}
function mergeSettings(s){
  return {...DEFAULT_SETTINGS,...s,
    issuer:{...DEFAULT_SETTINGS.issuer,...(s.issuer||{})},
    client:{...DEFAULT_SETTINGS.client,...(s.client||{})},
    bank:{...DEFAULT_SETTINGS.bank,...(s.bank||{})}};
}
async function migrate(){
  try{
    const e=localStorage.getItem('salary_manager_employees');
    const r=localStorage.getItem('salary_manager_records');
    const s=localStorage.getItem('salary_manager_settings');
    let did=false;
    if(e){STATE.employees=JSON.parse(e);did=true;}
    if(r){STATE.records=JSON.parse(r);did=true;}
    if(s){STATE.settings=mergeSettings(JSON.parse(s));did=true;}
    if(did){STATE.ready=true;await Promise.all([saveEmployees(),saveRecords(),saveSettings(),saveReady()]);}
  }catch(e){}
}

/* ---------- TABS ---------- */
function switchTab(t){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tb').forEach(b=>b.classList.remove('active'));
  $('page-'+t).classList.add('active');
  $('tb-'+t).classList.add('active');
  const cfg={att:['日給管理','ATTENDANCE',true],bill:['請求','INVOICE',false],set:['設定','SETTINGS',false]};
  $('ph-name').textContent=cfg[t][0]; $('ph-sub').textContent=cfg[t][1];
  $('ph-month').style.display=cfg[t][2]?'flex':'none';
  if(t==='bill')renderBill();
  if(t==='set')renderSettingsLists();
}
$('tb-att').addEventListener('click',()=>switchTab('att'));
$('tb-bill').addEventListener('click',()=>switchTab('bill'));
$('tb-set').addEventListener('click',()=>switchTab('set'));

/* ---------- month nav (header, 勤怠タブ) ---------- */
$('hm-prev').addEventListener('click',()=>{if(viewM===1){viewM=12;viewY--;}else viewM--;renderAtt();});
$('hm-next').addEventListener('click',()=>{if(viewM===12){viewM=1;viewY++;}else viewM++;renderAtt();});
function updateHeaderMonth(){$('hm-label').textContent=`${viewY}年${viewM}月`;}

/* ---------- RENDER ALL ---------- */
function renderAll(){updateHeaderMonth();renderEmpRow();renderAtt();}

/* ===== 勤怠タブ ===== */
function renderEmpRow(){
  const row=$('emp-row');row.innerHTML='';
  STATE.employees.forEach(e=>{
    const c=document.createElement('div');
    c.className='emp-chip'+(e.id===selEmp?' sel':'');
    c.textContent=e.name;
    c.addEventListener('click',()=>{selEmp=e.id;renderEmpRow();renderAtt();});
    row.appendChild(c);
  });
  const add=document.createElement('div');
  add.className='emp-chip add';add.textContent='＋ 追加';
  add.addEventListener('click',()=>openEmpModal(null));
  row.appendChild(add);
}

function renderAtt(){
  updateHeaderMonth();
  const body=$('att-body');
  const emp=STATE.employees.find(e=>e.id===selEmp);
  if(!emp){
    body.innerHTML='<div class="empty">従業員がいません<br>上の「＋ 追加」から登録してください</div>';
    return;
  }
  const days=daysInMonthList(viewY,viewM);
  const recMap=new Map();
  STATE.records.forEach(r=>{if(r.employeeId===emp.id)recMap.set(r.date,r);});
  const otRate=overtimeRate(emp.dailyWage);

  let runTotal=0;
  const otRateN=overtimeRate(emp.nightWage||0);
  const nightEnabled=(emp.nightWage||0)>0;
  let html=`<div class="card" style="padding:13px 14px;">
    <div class="att-head">
      <div><div class="att-emp">${esc(emp.name)}</div>
      <div class="att-meta">日給 ${yen(emp.dailyWage)}　残業 ${yen(Math.round(otRate))}/h${nightEnabled?`<br>夜間 ${yen(emp.nightWage)}　夜残業 ${yen(Math.round(otRateN))}/h`:''}</div></div>
      <button class="btn btn-ghost btn-sm" style="width:auto;" onclick="openEmpModal('${emp.id}')">編集</button>
    </div></div>`;

  html+='<div class="day-list">';
  days.forEach(ds=>{
    const d=new Date(ds+'T00:00:00');const dow=d.getDay();
    const rec=recMap.get(ds)||{attendance:0,overtimeHours:0,nightAttendance:0,nightOvertimeHours:0,transportFee:0};
    const t=dailyTotal(rec,emp);
    const has=recHasData(rec);
    if(has)runTotal+=t.total;
    const hasNight=(rec.nightAttendance>0||rec.nightOvertimeHours>0);
    const showNight=nightEnabled&&(hasNight||nightExpanded.has(ds));
    const cls=['day'];if(rec.attendance>0||hasNight)cls.push('work');if(dow===0)cls.push('weekend');if(dow===6)cls.push('sat');
    const attOpts=[0.5,1,1.5,2];
    html+=`<div class="${cls.join(' ')}">
      <div class="dcell-l"><div class="dnum">${d.getDate()}</div><div class="ddow">${WEEK[dow]}</div></div>
      <div class="dcell-r">
        <div class="shift-label">日勤</div>
        <div class="att-btns">
          <button class="att-b${rec.attendance===0?' sel':''}" onclick="setAtt('${ds}','attendance',0)">休</button>
          ${attOpts.map(v=>`<button class="att-b${rec.attendance===v?' sel':''}" onclick="setAtt('${ds}','attendance',${v})">${v}</button>`).join('')}
        </div>
        <div class="att-sub">
          <div class="att-mini"><label>残業h</label><input type="number" inputmode="decimal" value="${rec.overtimeHours||''}" placeholder="0" onchange="setAtt('${ds}','overtimeHours',this.value)"></div>
          <div class="att-mini"><label>車代</label><input type="number" inputmode="numeric" value="${rec.transportFee||''}" placeholder="0" onchange="setAtt('${ds}','transportFee',this.value)"></div>
        </div>
        ${showNight?`
        <div class="night-sec">
          <div class="shift-label night">夜勤</div>
          <div class="att-btns">
            <button class="att-b night${(rec.nightAttendance||0)===0?' sel':''}" onclick="setAtt('${ds}','nightAttendance',0)">休</button>
            ${attOpts.map(v=>`<button class="att-b night${rec.nightAttendance===v?' sel':''}" onclick="setAtt('${ds}','nightAttendance',${v})">${v}</button>`).join('')}
          </div>
          <div class="att-sub">
            <div class="att-mini"><label>夜残業h</label><input type="number" inputmode="decimal" value="${rec.nightOvertimeHours||''}" placeholder="0" onchange="setAtt('${ds}','nightOvertimeHours',this.value)"></div>
            <div class="att-mini" style="visibility:hidden;"><label>　</label><input disabled></div>
          </div>
        </div>`:(nightEnabled?`<button class="night-add" onclick="toggleNight('${ds}')">＋ 夜勤を入力</button>`:'')}
        ${has?`<div class="day-total">${yen(t.total)}</div>`:''}
      </div>
    </div>`;
  });
  html+='</div>';

  html+=`<div class="runbar"><span class="rl">${viewY}年${viewM}月 合計（暦月）</span><span class="rv">${yen(runTotal)}</span></div>`;
  body.innerHTML=html;
}

function setAtt(date,field,value){
  if(!selEmp)return;
  let v=parseFloat(value)||0; if(v<0)v=0;
  let rec=STATE.records.find(r=>r.employeeId===selEmp&&r.date===date);
  if(!rec){rec={id:uid(),employeeId:selEmp,date,attendance:0,overtimeHours:0,nightAttendance:0,nightOvertimeHours:0,transportFee:0};STATE.records.push(rec);}
  rec[field]=v;
  saveRecords();
  renderAtt();
}
window.setAtt=setAtt;
function toggleNight(ds){
  if(nightExpanded.has(ds))nightExpanded.delete(ds);else nightExpanded.add(ds);
  renderAtt();
}
window.toggleNight=toggleNight;

/* ---------- 従業員モーダル ---------- */
function openEmpModal(id){
  editEmpId=id;
  const emp=id?STATE.employees.find(e=>e.id===id):null;
  $('emp-modal-title').textContent=emp?'従業員を編集':'従業員を追加';
  $('emp-name').value=emp?emp.name:'';
  $('emp-wage').value=emp?emp.dailyWage:'';
  $('emp-nwage').value=(emp&&emp.nightWage)?emp.nightWage:'';
  $('emp-delete').style.display=emp?'flex':'none';
  updateEmpHint();
  $('emp-modal').classList.add('show');
}
window.openEmpModal=openEmpModal;
function closeEmpModal(){$('emp-modal').classList.remove('show');editEmpId=null;}
$('emp-modal-close').addEventListener('click',closeEmpModal);
$('emp-modal').addEventListener('click',e=>{if(e.target===$('emp-modal'))closeEmpModal();});
$('emp-wage').addEventListener('input',updateEmpHint);
$('emp-nwage').addEventListener('input',updateEmpHint);
function updateEmpHint(){
  const w=parseInt($('emp-wage').value,10)||0;
  const nw=parseInt($('emp-nwage').value,10)||0;
  let lines=[];
  if(w>0) lines.push(`日勤残業 = ${yen(w)} ÷ 8 × 1.25 = ${yen(Math.round(overtimeRate(w)))}/h`);
  if(nw>0) lines.push(`夜勤残業 = ${yen(nw)} ÷ 8 × 1.25 = ${yen(Math.round(overtimeRate(nw)))}/h`);
  $('emp-ot-hint').innerHTML=lines.join('<br>');
}
$('emp-save').addEventListener('click',()=>{
  const name=$('emp-name').value.trim();
  const wage=parseInt($('emp-wage').value,10);
  const nwageRaw=$('emp-nwage').value.trim();
  const nwage=nwageRaw===''?0:(parseInt(nwageRaw,10)||0);
  if(!name){toast('⚠️ 名前を入力してください');return;}
  if(isNaN(wage)||wage<=0){toast('⚠️ 日給を正しく入力してください');return;}
  if(editEmpId){
    const e=STATE.employees.find(x=>x.id===editEmpId);
    if(e){e.name=name;e.dailyWage=wage;e.nightWage=nwage;}
  }else{
    const e={id:uid(),name,dailyWage:wage,nightWage:nwage,createdAt:new Date().toISOString()};
    STATE.employees.push(e);selEmp=e.id;
  }
  saveEmployees();closeEmpModal();renderEmpRow();renderAtt();
  toast('保存しました ✓');
});
$('emp-delete').addEventListener('click',()=>{
  if(!editEmpId)return;
  if(!confirm('この従業員と勤怠データを削除しますか？元に戻せません。'))return;
  STATE.employees=STATE.employees.filter(e=>e.id!==editEmpId);
  STATE.records=STATE.records.filter(r=>r.employeeId!==editEmpId);
  if(selEmp===editEmpId)selEmp=STATE.employees[0]?.id||null;
  Promise.all([saveEmployees(),saveRecords()]);
  closeEmpModal();renderEmpRow();renderAtt();
  toast('削除しました');
});

/* ===== 請求タブ ===== */
$('pd-prev').addEventListener('click',()=>{if(billM===1){billM=12;billY--;}else billM--;renderBill();});
$('pd-next').addEventListener('click',()=>{if(billM===12){billM=1;billY++;}else billM++;renderBill();});

function renderBill(){
  const s=STATE.settings;
  const period=billingPeriod(billY,billM,s.closingDay);
  $('pd-main').textContent=period.periodLabel;
  $('pd-sub').textContent=period.label;

  const reports=STATE.employees.map(e=>({emp:e,rep:periodReport(e,period.start,period.end)}))
    .filter(x=>x.rep.grandTotal>0);

  let subtotal=0; reports.forEach(x=>subtotal+=x.rep.grandTotal);
  const tax=calcTax(subtotal,s.taxRate);
  const total=subtotal+tax;
  $('grand-v').textContent=reports.length?yen(total):'¥ —';
  $('grand-sub').textContent=reports.length?`税抜 ${yen(subtotal)} ＋ 消費税 ${yen(tax)}（${reports.length}名）`:'この期間のデータがありません';

  const list=$('sum-list');list.innerHTML='';
  if(!reports.length){
    list.innerHTML='<div class="empty">この締め期間の勤怠データがありません<br>「勤怠」タブで入力してください</div>';
    $('batch-pdf-btn').style.display='none';
    return;
  }
  $('batch-pdf-btn').style.display='flex';
  reports.forEach(({emp,rep})=>{
    const div=document.createElement('div');div.className='sum-emp';
    div.innerHTML=`
      <div class="sum-emp-top"><div class="sum-emp-name">${esc(emp.name)}</div><div class="sum-emp-total">${yen(rep.grandTotal)}</div></div>
      <div class="sum-emp-detail">
        <span>日勤 ${rep.totalAttendance}日</span>
        <span>日給 ${yen(rep.totalDailyWage)}</span>
        <span>残業 ${yen(rep.totalOvertimePay)}</span>
        ${rep.totalNightAttendance>0||rep.totalNightWage>0?`<span>夜勤 ${rep.totalNightAttendance}日</span><span>夜間 ${yen(rep.totalNightWage)}</span><span>夜残業 ${yen(rep.totalNightOvertimePay)}</span>`:''}
        <span>車代 ${yen(rep.totalTransportFee)}</span>
      </div>
      <button class="btn btn-navy btn-sm sum-emp-btn" onclick="makeInvoice('${emp.id}')">📄 ${esc(emp.name)}の請求書PDF</button>`;
    list.appendChild(div);
  });
}

/* ===== PDF ===== */
function makeInvoice(empId){
  const emp=STATE.employees.find(e=>e.id===empId);if(!emp)return;
  const s=STATE.settings;
  const period=billingPeriod(billY,billM,s.closingDay);
  const rep=periodReport(emp,period.start,period.end);
  if(rep.grandTotal<=0){toast('⚠️ データがありません');return;}
  showPreview(
    buildInvoiceHTML([{emp,rep}],period,false,'screen'),
    buildInvoiceHTML([{emp,rep}],period,false,'print')
  );
}
window.makeInvoice=makeInvoice;

$('batch-pdf-btn').addEventListener('click',()=>{
  const s=STATE.settings;
  const period=billingPeriod(billY,billM,s.closingDay);
  const reports=STATE.employees.map(e=>({emp:e,rep:periodReport(e,period.start,period.end)})).filter(x=>x.rep.grandTotal>0);
  if(!reports.length){toast('⚠️ データがありません');return;}
  showPreview(
    buildInvoiceHTML(reports,period,true,'screen'),
    buildInvoiceHTML(reports,period,true,'print')
  );
});

function showPreview(screenHTML,printHTML){
  $('pv-scroll').innerHTML=screenHTML;   // 画面用（幅フィット）
  $('print-root').innerHTML=printHTML;   // 印刷用（A4原寸）
  $('pv-overlay').classList.add('show');
  $('pv-scroll').scrollTop=0;
}
$('pv-close').addEventListener('click',()=>$('pv-overlay').classList.remove('show'));
$('pv-print').addEventListener('click',()=>{setTimeout(()=>{window.print();},60);});

/* A4 2ページ請求書HTML（ネイビー×白・帳票風）
   cssMode: 'print'(A4原寸) または 'screen'(画面幅フィット) */
function buildInvoiceHTML(reports,period,batch,cssMode){
  const s=STATE.settings;
  const css=(cssMode==='screen')?SCREEN_CSS:PRINT_CSS;
  const issueDate=fmtDateJ(ymd(new Date().getFullYear(),new Date().getMonth()+1,new Date().getDate()));
  const invNo=batch?`${billY}-${pad2(billM)}-ALL`:`${billY}-${pad2(billM)}-${(reports[0].emp.id).replace(/[^0-9]/g,'').slice(0,3).padStart(3,'0')||'001'}`;

  let subtotal=0; reports.forEach(r=>subtotal+=r.rep.grandTotal);
  const tax=calcTax(subtotal,s.taxRate);
  const total=subtotal+tax;

  const issuer=s.issuer,client=s.client,bank=s.bank;

  // ---- 1ページ目 ----
  const titleSub=batch?`まとめ請求書（${reports.length}名分）`:`${esc(reports[0].emp.name)} 様分`;
  const empRows=reports.map(r=>{
    const rp=r.rep;
    const att=rp.totalAttendance+rp.totalNightAttendance;
    const wage=rp.totalDailyWage+rp.totalNightWage;
    const ot=rp.totalOvertimePay+rp.totalNightOvertimePay;
    return `
    <tr><td>${esc(r.emp.name)}</td>
    <td class="inv-r">${att}日</td>
    <td class="inv-r">${yen(wage)}</td>
    <td class="inv-r">${yen(ot)}</td>
    <td class="inv-r">${yen(rp.totalTransportFee)}</td>
    <td class="inv-r inv-bold">${yen(rp.grandTotal)}</td></tr>`;
  }).join('');

  const bankBlock=(bank.bankName||bank.accountNumber)?`
    <div class="inv-bank-box"><div class="inv-bank-title">お振込先</div>
      <div class="inv-bank-row">${esc(bank.bankName)} ${esc(bank.branchName)} ${esc(bank.accountType)} ${esc(bank.accountNumber)}</div>
      <div class="inv-bank-row">名義：${esc(bank.accountHolder)}</div>
    </div>`:'';

  const page1=`<div class="inv-page">
    <div class="inv-p1-top">
      <div>
        <div class="inv-p1-title">請　求　書</div>
        <div class="inv-p1-meta">請求番号：${invNo}<br>発行日：${issueDate}<br>対象期間：${period.label}</div>
      </div>
      <div class="inv-p1-issuer">
        <div class="inv-p1-issuer-name">${esc(issuer.companyName||'（自社名未設定）')}</div>
        <div class="inv-p1-issuer-detail">
          ${issuer.postalCode?'〒'+esc(issuer.postalCode)+'<br>':''}
          ${esc(issuer.address)}<br>
          ${issuer.phone?'TEL：'+esc(issuer.phone)+'<br>':''}
          ${issuer.invoiceNumber?'登録番号：'+esc(issuer.invoiceNumber):''}
        </div>
      </div>
    </div>
    <hr class="inv-divider">
    <div class="inv-client-name">${esc(client.companyName||'（請求先未設定）')}　御中</div>
    <div class="inv-client-detail">
      ${client.postalCode?'〒'+esc(client.postalCode)+'　':''}${esc(client.address)}
      ${client.contactName?'<br>ご担当：'+esc(client.contactName)+' 様':''}
    </div>
    <div class="inv-subject">件名：${period.periodLabel} 人工代（${titleSub}）</div>

    <div class="inv-total-box">
      <div class="inv-total-label">ご請求金額（税込）</div>
      <div class="inv-total-amount">${yen(total)}</div>
      <div class="inv-total-sub"><span>税抜 ${yen(subtotal)}</span><span>消費税(${s.taxRate}%) ${yen(tax)}</span></div>
    </div>

    <table>
      <thead><tr><th>氏名</th><th class="inv-r">出勤</th><th class="inv-r">人工代</th><th class="inv-r">残業</th><th class="inv-r">車代</th><th class="inv-r">小計</th></tr></thead>
      <tbody>
        ${empRows}
        <tr class="inv-subtotal-row"><td>小計（税抜）</td><td></td><td></td><td></td><td></td><td class="inv-r">${yen(subtotal)}</td></tr>
        <tr class="inv-subtotal-row"><td>消費税（${s.taxRate}%）</td><td></td><td></td><td></td><td></td><td class="inv-r">${yen(tax)}</td></tr>
        <tr class="inv-total-row"><td>合計（税込）</td><td></td><td></td><td></td><td></td><td class="inv-r">${yen(total)}</td></tr>
      </tbody>
    </table>

    ${bankBlock}
    <div class="inv-p1-foot">登録番号 ${esc(issuer.invoiceNumber||'未設定')} ／ 適格請求書発行事業者</div>
  </div>`;

  // ---- 2ページ目：出面の内訳（従業員ごと）----
  let page2inner='';
  reports.forEach(({emp,rep})=>{
    const otRate=overtimeRate(emp.dailyWage);
    const nightOn=(emp.nightWage||0)>0||rep.totalNightWage>0;
    const otRateN=overtimeRate(emp.nightWage||0);
    const rows=daysInPeriod(period.start,period.end).map(ds=>{
      const rec=rep.records.find(r=>r.date===ds);
      if(!rec)return '';
      const t=dailyTotal(rec,emp);
      const d=new Date(ds+'T00:00:00');
      const dateLbl=`${d.getMonth()+1}/${d.getDate()}(${WEEK[d.getDay()]})`;
      const hasDay=(rec.attendance||0)>0||(rec.overtimeHours||0)>0;
      const hasNight=(rec.nightAttendance||0)>0||(rec.nightOvertimeHours||0)>0;
      let out='';
      // 車代は当日1回だけ（日勤行があれば日勤側、なければ夜勤側）
      const carOnDay=hasDay;
      if(hasDay){
        const dtl=t.wage+t.ot+(carOnDay?t.tr:0);
        out+=`<tr><td>${dateLbl}</td><td class="inv-c">日勤</td><td class="inv-c">${rec.attendance||0}</td><td class="inv-r">${yen(t.wage)}</td><td class="inv-r">${yen(t.ot)}</td><td class="inv-r">${carOnDay?yen(t.tr):'—'}</td><td class="inv-r inv-bold">${yen(dtl)}</td></tr>`;
      }
      if(hasNight){
        const ntl=t.nwage+t.not+(!carOnDay?t.tr:0);
        out+=`<tr><td>${hasDay?'':dateLbl}</td><td class="inv-c">夜勤</td><td class="inv-c">${rec.nightAttendance||0}</td><td class="inv-r">${yen(t.nwage)}</td><td class="inv-r">${yen(t.not)}</td><td class="inv-r">${!carOnDay?yen(t.tr):'—'}</td><td class="inv-r inv-bold">${yen(ntl)}</td></tr>`;
      }
      if(!hasDay&&!hasNight&&(rec.transportFee||0)>0){
        out+=`<tr><td>${dateLbl}</td><td class="inv-c">—</td><td class="inv-c">0</td><td class="inv-r">¥0</td><td class="inv-r">¥0</td><td class="inv-r">${yen(t.tr)}</td><td class="inv-r inv-bold">${yen(t.tr)}</td></tr>`;
      }
      return out;
    }).join('');
    const totWage=rep.totalDailyWage+rep.totalNightWage;
    const totOt=rep.totalOvertimePay+rep.totalNightOvertimePay;
    const totAtt=rep.totalAttendance+rep.totalNightAttendance;
    page2inner+=`
      <div class="inv-emp-block">
        <div class="inv-emp-block-title">${esc(emp.name)}　<span>日給 ${yen(emp.dailyWage)} / 残業 ${yen(Math.round(otRate))}/h${nightOn?` ・ 夜間 ${yen(emp.nightWage||0)} / 夜残業 ${yen(Math.round(otRateN))}/h`:''}</span></div>
        <table class="inv-detail">
          <thead><tr><th>日付</th><th class="inv-c">区分</th><th class="inv-c">出勤</th><th class="inv-r">人工代</th><th class="inv-r">残業代</th><th class="inv-r">車代</th><th class="inv-r">計</th></tr></thead>
          <tbody>${rows}
            <tr class="inv-total-row"><td>合計</td><td class="inv-c">${totAtt}</td><td class="inv-c"></td><td class="inv-r">${yen(totWage)}</td><td class="inv-r">${yen(totOt)}</td><td class="inv-r">${yen(rep.totalTransportFee)}</td><td class="inv-r">${yen(rep.grandTotal)}</td></tr>
          </tbody>
        </table>
      </div>`;
  });
  const page2=`<div class="inv-page"><div class="inv-p2-title">出面内訳　<span>${period.label}</span></div>${page2inner}</div>`;

  return `<style>${css}</style>${page1}${page2}`;
}

const PRINT_CSS=`
#print-root{font-family:'Hiragino Kaku Gothic ProN','Hiragino Sans','Meiryo',sans-serif;color:#1a1a1a;background:#fff;}
#print-root *{margin:0;padding:0;box-sizing:border-box;}
.inv-page{width:210mm;min-height:297mm;padding:14mm 15mm 12mm;background:#fff;page-break-after:always;position:relative;}
.inv-page:last-child{page-break-after:auto;}
.inv-p1-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:5mm;}
.inv-p1-title{font-size:24pt;font-weight:bold;letter-spacing:6px;color:#1a2744;}
.inv-p1-meta{font-size:8.5pt;color:#555;margin-top:4px;line-height:1.7;}
.inv-p1-issuer{text-align:right;}
.inv-p1-issuer-name{font-size:12pt;font-weight:bold;color:#1a2744;}
.inv-p1-issuer-detail{font-size:8pt;color:#555;margin-top:3px;line-height:1.6;}
.inv-divider{border:none;border-top:2px solid #1a2744;margin:3mm 0 4mm;}
.inv-client-name{font-size:15pt;font-weight:bold;color:#1a2744;margin-bottom:1.5mm;}
.inv-client-detail{font-size:8.5pt;color:#555;line-height:1.6;}
.inv-subject{font-size:9.5pt;color:#333;padding:2.5mm 0;border-bottom:1px solid #ddd;margin:3mm 0 5mm;}
.inv-total-box{background:#1a2744;color:#fff;border-radius:6px;padding:6mm 8mm;margin-bottom:5mm;text-align:center;}
.inv-total-label{font-size:9pt;opacity:.82;margin-bottom:2mm;letter-spacing:1px;}
.inv-total-amount{font-size:30pt;font-weight:bold;letter-spacing:2px;}
.inv-total-sub{font-size:8.5pt;opacity:.8;margin-top:2mm;}
.inv-total-sub span{margin:0 9px;}
.inv-page table{width:100%;border-collapse:collapse;margin-bottom:5mm;}
.inv-page th{background:#1a2744;color:#fff;padding:2.5mm 3mm;font-size:8.5pt;text-align:left;}
.inv-page td{padding:2mm 3mm;font-size:8.5pt;border-bottom:1px solid #e8eaf0;}
.inv-page tr:nth-child(even) td{background:#f7f8fc;}
.inv-subtotal-row td{background:#eef2ff!important;font-weight:bold;color:#1a2744;}
.inv-total-row td{background:#1a2744!important;color:#fff;font-weight:bold;font-size:9.5pt;}
.inv-r{text-align:right;}.inv-c{text-align:center;}.inv-bold{font-weight:bold;}
.inv-bank-box{border:1px solid #d1d5db;border-radius:4px;padding:3mm 4mm;background:#f9fafb;margin-bottom:4mm;}
.inv-bank-title{font-size:8.5pt;font-weight:bold;color:#1a2744;margin-bottom:2mm;padding-left:6px;border-left:3px solid #f59e0b;}
.inv-bank-row{font-size:8.5pt;color:#333;margin-top:1mm;}
.inv-p1-foot{position:absolute;bottom:10mm;left:15mm;right:15mm;font-size:7.5pt;color:#888;border-top:1px solid #eee;padding-top:2mm;}
.inv-p2-title{font-size:14pt;font-weight:bold;color:#1a2744;margin-bottom:5mm;border-bottom:2px solid #1a2744;padding-bottom:2mm;}
.inv-p2-title span{font-size:9pt;color:#666;font-weight:normal;}
.inv-emp-block{margin-bottom:7mm;}
.inv-emp-block-title{font-size:10pt;font-weight:bold;color:#1a2744;margin-bottom:2mm;padding-left:7px;border-left:4px solid #f59e0b;}
.inv-emp-block-title span{font-size:8pt;color:#666;font-weight:normal;}
.inv-page table.inv-detail th{font-size:8pt;padding:2mm;}
.inv-page table.inv-detail td{font-size:8pt;padding:1.6mm 2mm;}
@page{size:A4;margin:0;}
`;

/* 画面プレビュー用CSS（A4固定をやめ、画面幅にフィット） */
const SCREEN_CSS=`
#pv-scroll *{margin:0;padding:0;box-sizing:border-box;}
#pv-scroll{font-family:'Hiragino Kaku Gothic ProN','Hiragino Sans','Meiryo',sans-serif;color:#1a1a1a;}
.inv-page{width:100%;max-width:760px;min-height:auto;background:#fff;border-radius:6px;padding:22px 18px;box-shadow:0 6px 24px rgba(0,0,0,.35);}
.inv-p1-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px;}
.inv-p1-title{font-size:22px;font-weight:bold;letter-spacing:5px;color:#1a2744;}
.inv-p1-meta{font-size:11px;color:#555;margin-top:5px;line-height:1.7;}
.inv-p1-issuer{text-align:right;}
.inv-p1-issuer-name{font-size:15px;font-weight:bold;color:#1a2744;}
.inv-p1-issuer-detail{font-size:10px;color:#555;margin-top:3px;line-height:1.6;}
.inv-divider{border:none;border-top:2px solid #1a2744;margin:10px 0 14px;}
.inv-client-name{font-size:18px;font-weight:bold;color:#1a2744;margin-bottom:4px;}
.inv-client-detail{font-size:11px;color:#555;line-height:1.6;}
.inv-subject{font-size:12px;color:#333;padding:9px 0;border-bottom:1px solid #ddd;margin:10px 0 16px;}
.inv-total-box{background:#1a2744;color:#fff;border-radius:8px;padding:18px;margin-bottom:16px;text-align:center;}
.inv-total-label{font-size:11px;opacity:.82;margin-bottom:6px;letter-spacing:1px;}
.inv-total-amount{font-size:34px;font-weight:bold;letter-spacing:1px;}
.inv-total-sub{font-size:11px;opacity:.85;margin-top:6px;}
.inv-total-sub span{margin:0 8px;}
.inv-page table{width:100%;border-collapse:collapse;margin-bottom:16px;}
.inv-page th{background:#1a2744;color:#fff;padding:8px 7px;font-size:11px;text-align:left;}
.inv-page td{padding:7px;font-size:11px;border-bottom:1px solid #e8eaf0;}
.inv-page tr:nth-child(even) td{background:#f7f8fc;}
.inv-subtotal-row td{background:#eef2ff!important;font-weight:bold;color:#1a2744;}
.inv-total-row td{background:#1a2744!important;color:#fff;font-weight:bold;font-size:12px;}
.inv-r{text-align:right;}.inv-c{text-align:center;}.inv-bold{font-weight:bold;}
.inv-bank-box{border:1px solid #d1d5db;border-radius:6px;padding:12px;background:#f9fafb;margin-bottom:14px;}
.inv-bank-title{font-size:11px;font-weight:bold;color:#1a2744;margin-bottom:6px;padding-left:7px;border-left:3px solid #f59e0b;}
.inv-bank-row{font-size:11px;color:#333;margin-top:3px;}
.inv-p1-foot{font-size:10px;color:#888;border-top:1px solid #eee;padding-top:8px;margin-top:8px;}
.inv-p2-title{font-size:18px;font-weight:bold;color:#1a2744;margin-bottom:14px;border-bottom:2px solid #1a2744;padding-bottom:7px;}
.inv-p2-title span{font-size:12px;color:#666;font-weight:normal;}
.inv-emp-block{margin-bottom:20px;}
.inv-emp-block-title{font-size:14px;font-weight:bold;color:#1a2744;margin-bottom:7px;padding-left:8px;border-left:4px solid #f59e0b;}
.inv-emp-block-title span{font-size:11px;color:#666;font-weight:normal;}
.inv-page table.inv-detail th{font-size:10px;padding:6px;}
.inv-page table.inv-detail td{font-size:10px;padding:5px 6px;}
`;

/* ===== 設定タブ ===== */
function buildClosingOptions(){
  const sel=$('set-closing');sel.innerHTML='';
  for(let d=1;d<=28;d++){const o=document.createElement('option');o.value=d;o.textContent=d+'日締め';sel.appendChild(o);}
  const o=document.createElement('option');o.value=31;o.textContent='月末締め';sel.appendChild(o);
}
function loadSettingsForm(){
  const s=STATE.settings;
  $('iss-name').value=s.issuer.companyName;$('iss-zip').value=s.issuer.postalCode;$('iss-tel').value=s.issuer.phone;$('iss-addr').value=s.issuer.address;$('iss-invno').value=s.issuer.invoiceNumber;
  $('cli-name').value=s.client.companyName;$('cli-zip').value=s.client.postalCode;$('cli-contact').value=s.client.contactName;$('cli-addr').value=s.client.address;
  $('bk-bank').value=s.bank.bankName;$('bk-branch').value=s.bank.branchName;$('bk-type').value=s.bank.accountType;$('bk-num').value=s.bank.accountNumber;$('bk-holder').value=s.bank.accountHolder;
  $('set-tax').value=String(s.taxRate);$('set-closing').value=String(s.closingDay);$('set-transport').value=s.defaultTransportFee;
}
function bindSettings(){
  const m=[
    ['iss-name',v=>STATE.settings.issuer.companyName=v],['iss-zip',v=>STATE.settings.issuer.postalCode=v],
    ['iss-tel',v=>STATE.settings.issuer.phone=v],['iss-addr',v=>STATE.settings.issuer.address=v],
    ['iss-invno',v=>STATE.settings.issuer.invoiceNumber=v],
    ['cli-name',v=>STATE.settings.client.companyName=v],['cli-zip',v=>STATE.settings.client.postalCode=v],
    ['cli-contact',v=>STATE.settings.client.contactName=v],['cli-addr',v=>STATE.settings.client.address=v],
    ['bk-bank',v=>STATE.settings.bank.bankName=v],['bk-branch',v=>STATE.settings.bank.branchName=v],
    ['bk-type',v=>STATE.settings.bank.accountType=v],['bk-num',v=>STATE.settings.bank.accountNumber=v],
    ['bk-holder',v=>STATE.settings.bank.accountHolder=v],
    ['set-tax',v=>STATE.settings.taxRate=parseInt(v,10)||0],
    ['set-closing',v=>STATE.settings.closingDay=parseInt(v,10)||31],
    ['set-transport',v=>STATE.settings.defaultTransportFee=parseInt(v,10)||0],
  ];
  m.forEach(([id,fn])=>{
    const el=$(id);const ev=(el.tagName==='SELECT')?'change':'input';
    el.addEventListener(ev,()=>{fn(el.value);saveSettings();});
  });
}
function renderSettingsLists(){
  const list=$('set-emp-list');list.innerHTML='';
  if(!STATE.employees.length){list.innerHTML='<div style="font-size:.82rem;color:var(--mut);padding:4px 0;">従業員が登録されていません</div>';return;}
  STATE.employees.forEach(e=>{
    const div=document.createElement('div');div.className='edititem';
    div.innerHTML=`<span class="ei-name">${esc(e.name)}</span><span class="ei-wage">${yen(e.dailyWage)}</span><button onclick="openEmpModal('${e.id}')">✏️</button>`;
    list.appendChild(div);
  });
}
$('set-add-emp').addEventListener('click',()=>openEmpModal(null));

/* データ管理 */
function buildBackup(){return JSON.stringify({app:'日給管理・請求書',version:APP_VERSION,exportedAt:new Date().toISOString(),employees:STATE.employees,records:STATE.records,settings:STATE.settings},null,2);}
$('export-btn').addEventListener('click',()=>{
  const blob=new Blob([buildBackup()],{type:'application/json'});
  const url=URL.createObjectURL(blob);const a=document.createElement('a');
  a.href=url;a.download=`salary-backup-${ymd(new Date().getFullYear(),new Date().getMonth()+1,new Date().getDate())}.json`;
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),1500);toast('バックアップを保存しました');
});
$('import-btn').addEventListener('click',()=>{
  const inp=document.createElement('input');inp.type='file';inp.accept='application/json,.json';
  inp.addEventListener('change',async()=>{
    const f=inp.files&&inp.files[0];if(!f)return;
    try{
      const o=JSON.parse(await f.text());
      if(Array.isArray(o.employees))STATE.employees=o.employees;
      if(Array.isArray(o.records))STATE.records=o.records;
      if(o.settings)STATE.settings=mergeSettings(o.settings);
      STATE.ready=true;
      await Promise.all([saveEmployees(),saveRecords(),saveSettings(),saveReady()]);
      toast('復元しました ✓');setTimeout(()=>location.reload(),700);
    }catch(e){toast('⚠️ ファイルを読めませんでした');}
  });
  inp.click();
});
$('reset-btn').addEventListener('click',async()=>{
  if(!confirm('全データを削除しますか？元に戻せません。\n（先にバックアップ保存を推奨）'))return;
  await idbClear();try{localStorage.clear();}catch(e){}location.reload();
});
$('reload-btn').addEventListener('click',()=>location.reload());

bindSettings();
