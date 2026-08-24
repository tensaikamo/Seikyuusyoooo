'use strict';
/* =============================================================
   日給管理・請求書 — iPhone単一HTML版（依存ゼロ）
   ネイビー×白 / IndexedDB / A4印刷・PDF保存
   ============================================================= */
const APP_VERSION='1.13.0';

/* ---------- レポートの既定の送信先 ----------
   ここに入れておくと、端末ごとに設定しなくても自動送信が働く。
   使う人が設定画面で書き換えたらそちらが優先され、以後ここは上書きしない。
   合言葉は認証ではなく荒らし避け。これが漏れても届くのはレポートだけで、
   受け取ったものを読むための鍵（ADMIN_KEY）とは別物。 */
const DEFAULT_REPORT={
  url:'https://seikyuusyo-reports.hi-vv1vv-0213.workers.dev/report',
  key:'98ec011f86b391560a3031944cd594b8952bc6cf2496d625',
  auto:true,     // 送信先が入っていれば既定で自動送信する
  autoData:false // 実データは既定では送らない（直すだけなら要らない）
};

/* ---------- HTML escape ---------- */
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

/* ---------- IndexedDB (kv) ---------- */
const DB='salary-db',STORE='kv';let _dbp=null;
function db(){if(_dbp)return _dbp;_dbp=new Promise((res,rej)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(STORE))r.result.createObjectStore(STORE);};r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});return _dbp;}
function idbGet(k){return db().then(d=>new Promise((res,rej)=>{const r=d.transaction(STORE,'readonly').objectStore(STORE).get(k);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);}));}
function idbSet(k,v){return db().then(d=>new Promise((res,rej)=>{const t=d.transaction(STORE,'readwrite');t.objectStore(STORE).put(v,k);t.oncomplete=()=>res();t.onerror=()=>rej(t.error);}));}
/* 復元は全キーを1つのtransactionで入れ替える。途中失敗で一部だけ新旧が混ざらない。 */
function idbSetMany(entries){return db().then(d=>new Promise((res,rej)=>{const t=d.transaction(STORE,'readwrite'),s=t.objectStore(STORE);entries.forEach(([k,v])=>s.put(v,k));t.oncomplete=()=>res();t.onabort=()=>rej(t.error||new Error('保存を中断しました'));t.onerror=()=>rej(t.error);}));}
function idbClear(){return db().then(d=>new Promise((res,rej)=>{const t=d.transaction(STORE,'readwrite');t.objectStore(STORE).clear();t.oncomplete=()=>res();t.onerror=()=>rej(t.error);}));}

/* ---------- id ---------- */
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,8);}

/* ---------- STATE ---------- */
const WEEK=['日','月','火','水','木','金','土'];
const DEFAULT_SETTINGS={
  defaultTransportFee:1000,taxRate:10,closingDay:31,monthlyGoal:0,
  // 1日の所定労働時間。残業単価の基礎（日給÷所定時間）に使う。
  // 労基則19条は「日給÷1日の所定労働時間数」と定めており、8は定数ではない。
  // 7.5時間なのに8で割ると残業単価が低くなり、支払が法定を下回る。
  workHours:8,
  issuer:{companyName:'',postalCode:'',address:'',phone:'',invoiceNumber:''},
  client:{companyName:'',postalCode:'',address:'',contactName:''},
  bank:{bankName:'',branchName:'',accountType:'普通',accountNumber:'',accountHolder:''}
};
let STATE={
  employees:[],      // {id,name,dailyWage,nightWage,createdAt}
  records:[],        // {id,employeeId,date,attendance,overtimeHours,nightAttendance,nightOvertimeHours,transportFee,note}
  settings:JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
  invoiceLog:[],     // 発行履歴。取消は元記録を変えず取消レコードを追記
  usageLog:[],       // 利用の記録
  // レポートの送信先と自動送信の設定。バックアップにもレポート本文にも含めない
  reportDest:{url:'',key:'',auto:false,autoData:false,touched:false,lastAt:0,lastSig:'',device:''},
  ready:false
};
let viewY=new Date().getFullYear(), viewM=new Date().getMonth()+1; // 1-12
let selEmp=null;       // 勤怠タブで選択中のemployeeId
/* 開閉状態は「従業員ID|日付」をキーにする（日付だけだと従業員を切り替えても開いたままになる） */
let nightExpanded=new Set(); // 夜勤欄を開いている 従業員ID|日付
let manualExpanded=new Set(); // 合計手入力欄を開いている 従業員ID|日付
function xk(ds){return selEmp+'|'+ds;}
let billY=new Date().getFullYear(), billM=new Date().getMonth()+1; // 請求タブの請求月
let lastRunTotal=null;   // runbarカウントアップの前回値
let lastGrandTotal=null; // 請求合計カウントアップの前回値
let editEmpId=null;    // モーダル編集対象

/* ---------- 索引キャッシュ ----------
   レコードのループ内で employees.find() を呼ぶと O(レコード数 × 従業員数) になり、
   数年分たまると体感で遅くなる。従業員IDでの索引を作って使い回し、保存時に破棄する。 */
let _idx=null;
let dashDirty=true;   // データが変わったときだけダッシュボードを作り直す
let attDirty=false;   // 設定変更などで勤怠タブの再描画が必要か
function invalidateIdx(){_idx=null;dashDirty=true;}
function idx(){
  if(_idx)return _idx;
  const empById=new Map(STATE.employees.map(e=>[e.id,e]));
  const byEmp=new Map();
  STATE.employees.forEach(e=>byEmp.set(e.id,[]));
  canonicalRecords().forEach(r=>{const a=byEmp.get(r.employeeId);if(a)a.push(r);});
  byEmp.forEach(a=>a.sort((x,y)=>x.date<y.date?-1:x.date>y.date?1:0));
  _idx={empById,byEmp};
  return _idx;
}

/* ---------- 保存の失敗を必ず知らせる ----------
   以前は保存が失敗しても画面の数字は更新されたままで、警告も出なかった。
   端末の空きが尽きると「入れたのに翌朝には消えている」が起きる。
   一度でも失敗したら、消えるまで画面上部に警告を出し続ける。 */
let saveBroken=false;
function saveFailed(what,err){
  saveBroken=true;
  try{logUse('保存失敗',what+' / '+(err&&err.name||err));}catch(e){}
  const bar=$('save-alert');
  if(bar){
    bar.textContent='⚠️ 保存できていません。端末の空き容量を確認してください。'+
      'この状態で入力を続けると、閉じたときに消えます。';
    bar.classList.add('show');
  }
  try{toast('⚠️ 保存できませんでした');}catch(e){}
}
// 保存が通ったら警告を消す（空きを空けて復帰した場合）
function saveOK(){
  if(!saveBroken)return;
  saveBroken=false;
  const bar=$('save-alert');if(bar)bar.classList.remove('show');
}
/* 失敗しても投げ返さない。呼び出し側は誰も catch していないので、
   投げると未処理の拒否が積み上がるだけで、画面の警告以上のことは起きない。
   成否は真偽値で返し、確かめたい所（復元など）だけが見る。 */
function guard(what,p){
  return Promise.resolve(p).then(()=>{saveOK();return true;},e=>{saveFailed(what,e);return false;});
}
const saveEmployees=()=>{invalidateIdx();return guard('従業員',idbSet('employees',STATE.employees));};
const saveRecords=()=>{invalidateIdx();return guard('勤怠',idbSet('records',STATE.records));};
const saveSettings=()=>{dashDirty=true;attDirty=true;return guard('設定',idbSet('settings',STATE.settings));};
const saveInvoiceLog=()=>guard('発行履歴',idbSet('invoiceLog',STATE.invoiceLog));
const saveReady=()=>guard('初期化',idbSet('ready',STATE.ready));

/* ---------- 利用の記録 ----------
   端末の中だけに貯める。送信は本人が設定タブでボタンを押したときだけ行う。
   自動でどこかへ送ることはしない。 */
const USAGE_MAX=400;
let usageDirty=false;
function logUse(kind,detail){
  try{
    if(!Array.isArray(STATE.usageLog))STATE.usageLog=[];
    STATE.usageLog.push({t:Date.now(),k:kind,v:detail==null?'':String(detail).slice(0,200)});
    if(STATE.usageLog.length>USAGE_MAX)STATE.usageLog=STATE.usageLog.slice(-USAGE_MAX);
    usageDirty=true;
  }catch(e){}
}
const saveUsage=()=>{usageDirty=false;return idbSet('usageLog',STATE.usageLog);};
// 書き込みが増えすぎないよう、まとめて保存する
setInterval(()=>{if(usageDirty)saveUsage();},20000);
window.addEventListener('pagehide',()=>{if(usageDirty)saveUsage();});
// 気づかれない不具合を拾うため、エラーは必ず記録する
window.addEventListener('error',e=>logUse('error',`${e.message} @${(e.filename||'').split('/').pop()}:${e.lineno}`));
window.addEventListener('unhandledrejection',e=>logUse('error','promise: '+(e.reason&&e.reason.message||e.reason)));

/* ---------- 詰まりどころの記録 ----------
   「何を押したか」だけ数えても、どこで困っているかは分からない。
   打ち直し・開いたのに使わなかった・警告が出た、といった
   うまくいかなかった形跡を残す。氏名や金額は一切記録しない。 */
const friction={edits:new Map(),opened:new Map()};
// 同じ欄を何度も打ち直しているなら、その欄が入れにくいということ
function noteEdit(date,field){
  const k=field+'@'+date;
  const n=(friction.edits.get(k)||0)+1;
  friction.edits.set(k,n);
  if(n===4)logUse('打ち直し',field);   // 4回目で1度だけ記録する
}
// 開いたのに使わずに閉じた欄は、期待外れだったということ
function noteOpen(what){friction.opened.set(what,Date.now());}
function noteUsed(what){friction.opened.delete(what);}
function noteClosed(what){
  if(!friction.opened.has(what))return;
  friction.opened.delete(what);
  logUse('使わず閉じた',what);
}

/* ---------- utils ---------- */
function $(id){return document.getElementById(id);}
function toast(m){
  // 警告の出た回数はそのまま「使いにくかった回数」なので必ず記録する
  if(/⚠️/.test(m))logUse('警告',m.replace(/⚠️\s*/,'').slice(0,60));
  const e=$('toast');e.textContent=m;e.classList.add('show');clearTimeout(e._t);e._t=setTimeout(()=>e.classList.remove('show'),2200);
}
/* iOS標準スイッチの触覚を借りて振動させる。label.click() は対象のチェックボックスへ
   フォーカスを移してしまうため、元のフォーカス（入力中の欄）を必ず戻す。 */
function haptic(){
  try{
    const a=document.activeElement;
    $('hapticLbl').click();
    if(a&&a!==document.activeElement&&typeof a.focus==='function')a.focus({preventScroll:true});
  }catch(e){}
}
function yen(n){return '¥'+Math.round(n||0).toLocaleString('ja-JP');}
/* 金額の装飾マークアップ（¥を小さく・数字を太く） */
function yenHTML(n){return `<span class="mo"><span class="mo-y">¥</span><span class="mo-v">${Math.round(n||0).toLocaleString('ja-JP')}</span></span>`;}
/* 金額カウントアップ。el内の .mo-v（無ければel自身）のテキストを to までアニメーション */
function animateYen(el,to){
  if(!el)return;
  const v=el.querySelector('.mo-v')||el;
  const target=Math.round(to||0);
  const from=parseInt((v.textContent||'0').replace(/[^\d-]/g,''),10)||0;
  const fin=()=>{v.textContent=target.toLocaleString('ja-JP');};
  if(from===target||matchMedia('(prefers-reduced-motion: reduce)').matches){fin();return;}
  const t0=performance.now(),dur=550;
  (function step(t){
    const p=Math.min(1,(t-t0)/dur),e=1-Math.pow(1-p,3);
    v.textContent=Math.round(from+(target-from)*e).toLocaleString('ja-JP');
    if(p<1)requestAnimationFrame(step);else fin();
  })(t0);
}
/* SVGアイコン（ボタン用） */
const ICON_DOC='<svg class="ic" viewBox="0 0 24 24"><path d="M6.5 2.8h7.2L18.5 7.6v12.1a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 19.7V4.3a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M13.6 2.8v4.9h4.9"/><path d="M8.5 13h7M8.5 16.5h4.5"/></svg>';
function pad2(n){return String(n).padStart(2,'0');}
function ymd(y,m,d){return `${y}-${pad2(m)}-${pad2(d)}`;}
function fmtDateJ(s){const d=new Date(s+'T00:00:00');return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;}

/* ---------- calculations（元アプリと同一ロジック）---------- */
/* 残業単価 = 日給 ÷ 1日の所定労働時間 × 1.25。
   所定時間は設定から取る。以前は 8 を直に書いていたが、
   所定が7.5時間の職場では残業単価が実際より低くなっていた。 */
function workHours(){
  const h=Number(STATE&&STATE.settings&&STATE.settings.workHours);
  return (Number.isFinite(h)&&h>0&&h<=24)?h:8;
}
function overtimeRate(wage){return wage/workHours()*1.25;}

/* 単価の桁の打ち間違いを止める。
   上限100万円だけを見ていたため、18,000 を 180,000 と打っても素通りし、
   月の請求が10倍になっても誰も気づかなかった。
   下限は最低賃金。北海道は2025年10月から時給1,075円、2026年10月から1,131円の予定。
   地域や改定で変わるので「止める」のではなく「確認させる」。 */
const WAGE_SANE_MAX=60000;   // 1日6万円を超える日給はまず打ち間違い
const MIN_HOURLY=1075;       // 時給換算の目安（北海道・2025年10月〜）
function wageLooksSane(label,wage){
  if(wage>WAGE_SANE_MAX)
    return confirm(`${label}が ${yen(wage)} になっています。\n桁を間違えていませんか？\n\nこのままでよければOKを押してください。`);
  const hourly=Math.round(wage/8);
  if(hourly<MIN_HOURLY)
    return confirm(`${label} ${yen(wage)} は、8時間で割ると時給 ${yen(hourly)} です。\n`+
      `最低賃金（目安 ${yen(MIN_HOURLY)}）を下回っている可能性があります。\n\nこのままでよければOKを押してください。`);
  return true;
}
/** 1日の合計。日勤(昼)＋夜勤(夜)＋車代。
 *  emp.dailyWage … 日勤の日給 / emp.nightWage … 夜勤の夜間単価（未設定なら0）
 *  rec.attendance/overtimeHours … 日勤の出勤数/残業h
 *  rec.nightAttendance/nightOvertimeHours … 夜勤の出勤数/残業h */
/* 入力の上限。桁を打ち間違えても素通りしないようにする */
const INPUT_MAX={attendance:3,nightAttendance:3,overtimeHours:24,nightOvertimeHours:24,
  transportFee:100000,manualTotal:10000000};
const INPUT_LABEL={overtimeHours:'残業時間',nightOvertimeHours:'夜間残業',
  transportFee:'車代',manualTotal:'手入力の合計',attendance:'出勤数',nightAttendance:'夜勤の出勤数'};
/* その日に有効だった単価を返す。
   単価を上げたときに過去の月の金額まで書き換わってしまう問題への対策で、
   emp.wageHistory に「いつからの単価か」を残す。履歴が無ければ従来どおり現在の単価を使う。 */
function ratesOn(emp,date){
  const h=(emp&&Array.isArray(emp.wageHistory))?emp.wageHistory:null;
  if(!h||!h.length)return emp||{};
  let best=null;
  h.forEach(w=>{if(w.from<=date&&(!best||w.from>best.from))best=w;});
  if(best)return best;
  return h.reduce((a,b)=>a.from<b.from?a:b);   // すべて未来日なら一番古い単価を使う
}
/* 本人への支払単価。未設定なら請求単価と同額として扱う（既存データは従来どおり動く）。
   元請けへの請求単価と、本人に払う単価は建設業では別物で、差額が親方の取り分になる。 */
function payRates(emp,date){
  const r=ratesOn(emp,date||'9999-12-31');
  if(!r)return {dailyWage:0,nightWage:0};
  const d=Number(r.payWage),n=Number(r.payNightWage);
  return {
    dailyWage:(Number.isFinite(d)&&d>0)?d:(r.dailyWage||0),
    nightWage:(Number.isFinite(n)&&n>0)?n:(r.nightWage||0),
  };
}
/* その日の「本人への支払額」。請求額の計算をそのまま単価だけ差し替えて使う。
   手入力で固定した合計は元請けへの請求額なので、支払は必ず出面から計算する。 */
function payTotal(rec,emp){
  const r={...rec};
  delete r.manualTotal;           // 手入力の固定額は元請けへの請求額なので支払には使わない
  if(!r.transportToWorker)r.transportFee=0;  // 車代は基本渡さない。渡した日だけ含める
  return dailyTotal(r,payRates(emp,rec.date));
}
/* 数値の正規化。NaN・Infinity・負値・桁の打ち間違いを計算に持ち込まない。
   入力時のチェックをすり抜けた既存データやバックアップ復元にも効かせる。 */
function safeNum(v,max){
  const n=Number(v);
  if(!Number.isFinite(n)||n<0)return 0;
  return max!=null&&n>max?max:n;
}
const WAGE_MAX=1000000;
function normalizeRate(rate){
  return {dailyWage:safeNum(rate&&rate.dailyWage,WAGE_MAX),nightWage:safeNum(rate&&rate.nightWage,WAGE_MAX),
    payWage:safeNum(rate&&rate.payWage,WAGE_MAX),payNightWage:safeNum(rate&&rate.payNightWage,WAGE_MAX)};
}
/* 適用開始日以降の予約済み単価を置き換える。過去分はそのまま残す。 */
function replaceWageHistoryFrom(history,from,rate){
  const kept=(Array.isArray(history)?history:[]).filter(w=>w&&w.from<from).map(w=>({from:w.from,...normalizeRate(w)}));
  kept.push({from,...normalizeRate(rate)});
  return kept.sort((a,b)=>a.from<b.from?-1:a.from>b.from?1:0);
}
function dailyTotal(rec,emp){
  // 後方互換: 第2引数に数値(dailyWage)が渡された場合も動くようにする
  const src=(typeof emp==='number')?emp:ratesOn(emp,(rec&&rec.date)||'9999-12-31');
  const dayWage=safeNum((typeof src==='number')?src:(src&&src.dailyWage),WAGE_MAX);
  const nightWage=safeNum((typeof src==='number')?0:(src&&src.nightWage),WAGE_MAX);
  // 日勤。残業はその区分に出勤がある日だけ計上する
  // （「休」にしても残業hが残っていると課金されていた不具合の対策）
  const att=safeNum(rec.attendance,INPUT_MAX.attendance), natt=safeNum(rec.nightAttendance,INPUT_MAX.nightAttendance);
  const wage=Math.round(dayWage*att);
  const ot=att>0?Math.round(overtimeRate(dayWage)*safeNum(rec.overtimeHours,INPUT_MAX.overtimeHours)):0;
  // 夜勤
  const nwage=Math.round(nightWage*natt);
  const not=natt>0?Math.round(overtimeRate(nightWage)*safeNum(rec.nightOvertimeHours,INPUT_MAX.nightOvertimeHours)):0;
  const tr=Math.round(safeNum(rec.transportFee,INPUT_MAX.transportFee));
  const autoTotal=wage+ot+nwage+not+tr;
  // 手入力の上書き（その日だけ合計を固定）
  const manual=safeNum(rec.manualTotal,INPUT_MAX.manualTotal);
  const overridden=manual>0;
  const total=overridden?Math.round(manual):autoTotal;
  return {wage,ot,nwage,not,tr,autoTotal,total,overridden};
}
/** その記録に何か入力があるか（夜勤・手入力だけの日も拾う）*/
function recHasData(r){
  return (r.attendance||0)>0||(r.overtimeHours||0)>0||
         (r.nightAttendance||0)>0||(r.nightOvertimeHours||0)>0||
         (r.transportFee||0)>0||(Number(r.manualTotal)>0);
}
/* 旧データに同一人物・同一日の重複があれば後勝ちで1件に統一する。 */
function canonicalRecords(records=STATE.records){
  const byDay=new Map();
  (Array.isArray(records)?records:[]).forEach(r=>byDay.set(`${r&&r.employeeId}|${r&&r.date}`,r));
  return [...byDay.values()];
}
function recordForDay(employeeId,date){
  for(let i=STATE.records.length-1;i>=0;i--){const r=STATE.records[i];if(r.employeeId===employeeId&&r.date===date)return r;}
  return null;
}
/* 休み状態から初めて出勤を付ける瞬間だけ、設定した車代を候補にする。
   先に残業欄を触ってレコードが存在していても同じ扱いにし、既存車代は上書きしない。 */
function shouldApplyDefaultTransport(rec,field,value){
  if(value<=0||(field!=='attendance'&&field!=='nightAttendance'))return false;
  const hadWork=(rec.attendance||0)>0||(rec.nightAttendance||0)>0;
  return !hadWork&&safeNum(rec.transportFee,INPUT_MAX.transportFee)===0;
}
function daysInMonthList(y,m){const out=[];const d=new Date(y,m-1,1);while(d.getMonth()===m-1){out.push(ymd(d.getFullYear(),d.getMonth()+1,d.getDate()));d.setDate(d.getDate()+1);}return out;}

/* ---------- 日本の祝日（依存ゼロ・計算で算出 / 2000〜2099年） ---------- */
const _holCache={};
function holidaysOfYear(y){
  if(_holCache[y])return _holCache[y];
  const map={};
  const add=(m,d,name)=>{map[m+'-'+d]=name;};
  const nthMon=(m,n)=>{const first=new Date(y,m-1,1).getDay();return 1+((8-first)%7)+(n-1)*7;};
  add(1,1,'元日');
  add(1,nthMon(1,2),'成人の日');
  add(2,11,'建国記念の日');
  if(y>=2020)add(2,23,'天皇誕生日');else if(y<=2018)add(12,23,'天皇誕生日');
  add(3,Math.floor(20.8431+0.242194*(y-1980)-Math.floor((y-1980)/4)),'春分の日');
  add(4,29,y>=2007?'昭和の日':'みどりの日');
  add(5,3,'憲法記念日');
  if(y>=2007)add(5,4,'みどりの日');
  add(5,5,'こどもの日');
  if(y===2020)add(7,23,'海の日');else if(y===2021)add(7,22,'海の日');
  else if(y>=2003)add(7,nthMon(7,3),'海の日');else add(7,20,'海の日');
  if(y===2020)add(8,10,'山の日');else if(y===2021)add(8,8,'山の日');
  else if(y>=2016)add(8,11,'山の日');
  if(y>=2003)add(9,nthMon(9,3),'敬老の日');else add(9,15,'敬老の日');
  add(9,Math.floor(23.2488+0.242194*(y-1980)-Math.floor((y-1980)/4)),'秋分の日');
  if(y===2020)add(7,24,'スポーツの日');else if(y===2021)add(7,23,'スポーツの日');
  else add(10,nthMon(10,2),y>=2020?'スポーツの日':'体育の日');
  add(11,3,'文化の日');
  add(11,23,'勤労感謝の日');
  const isH=(m,d)=>!!map[m+'-'+d];
  // 国民の休日（前日も翌日も祝日の平日）
  const extra=[];
  for(let m=1;m<=12;m++){
    const dim=new Date(y,m,0).getDate();
    for(let d=1;d<=dim;d++){
      if(isH(m,d))continue;
      const dt=new Date(y,m-1,d);
      if(dt.getDay()===0)continue;
      const pv=new Date(y,m-1,d-1),nx=new Date(y,m-1,d+1);
      if(pv.getFullYear()===y&&nx.getFullYear()===y&&isH(pv.getMonth()+1,pv.getDate())&&isH(nx.getMonth()+1,nx.getDate()))
        extra.push([m,d]);
    }
  }
  extra.forEach(([m,d])=>add(m,d,'国民の休日'));
  // 振替休日（日曜の祝日 → 次の非祝日）
  const subs=[];
  for(let m=1;m<=12;m++){
    const dim=new Date(y,m,0).getDate();
    for(let d=1;d<=dim;d++){
      if(!isH(m,d))continue;
      if(new Date(y,m-1,d).getDay()!==0)continue;
      let nd=new Date(y,m-1,d+1);
      while(isH(nd.getMonth()+1,nd.getDate()))nd=new Date(nd.getFullYear(),nd.getMonth(),nd.getDate()+1);
      if(nd.getFullYear()===y)subs.push([nd.getMonth()+1,nd.getDate()]);
    }
  }
  subs.forEach(([m,d])=>add(m,d,'振替休日'));
  _holCache[y]=map;
  return map;
}
/** 祝日名（祝日でなければ null） */
function jpHoliday(y,m,d){return holidaysOfYear(y)[m+'-'+d]||null;}
function daysInPeriod(start,end){const out=[];const c=new Date(start+'T00:00:00'),e=new Date(end+'T00:00:00');while(c<=e){out.push(ymd(c.getFullYear(),c.getMonth()+1,c.getDate()));c.setDate(c.getDate()+1);}return out;}

/** 締め日から請求期間を計算（closingDay>=29は月末締め） */
function billingPeriod(year,month,closingDay){
  const monthEnd=closingDay>=29;
  let start,end;
  if(monthEnd){
    start=new Date(year,month-1,1);
    end=new Date(year,month,0);
  }else{
    // 前月の実際の締め日の「翌日」を開始日にする。2月に存在しない29日へ
    // 丸める方式だと、28日締めの2/28が2期間に重複していた。
    const prevClose=new Date(year,month-2,closingDay);
    start=new Date(prevClose);start.setDate(start.getDate()+1);
    end=new Date(year,month-1,closingDay);
  }
  const iso=d=>ymd(d.getFullYear(),d.getMonth()+1,d.getDate());
  const j=d=>`${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
  // y/m も返す。請求番号を「請求タブでいま見ている月」ではなく
  // 「実際に請求している期間」から採るため。
  return {y:year,m:month,start:iso(start),end:iso(end),
    label:`${j(start)}〜${j(end)}`,periodLabel:`${year}年${month}月分`};
}
function calcTax(sub,rate){return Math.floor(sub*(rate/100));}

/* 既存データに重複があっても、同一人物・同一日は最後の記録だけを採用する。 */
function recordsInPeriod(employeeId,start,end){
  const byDate=new Map();
  (idx().byEmp.get(employeeId)||[]).forEach(r=>{if(r.date>=start&&r.date<=end)byDate.set(r.date,r);});
  return [...byDate.values()].filter(recHasData).sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:0);
}

/** 期間レポート（従業員1人）*/
function periodReport(emp,start,end){
  const recs=recordsInPeriod(emp.id,start,end);
  let att=0,natt=0,wage=0,ot=0,nwage=0,not=0,tr=0;
  recs.forEach(r=>{
    const t=dailyTotal(r,emp);
    att+=r.attendance||0;
    natt+=r.nightAttendance||0;
    if(t.overridden){
      // 手入力の日は、合計を人工代バケットに寄せて内訳の整合を保つ
      wage+=t.total;
    }else{
      wage+=t.wage; ot+=t.ot; nwage+=t.nwage; not+=t.not; tr+=t.tr;
    }
  });
  return {employeeId:emp.id,
    totalAttendance:att, totalNightAttendance:natt,
    totalDailyWage:wage, totalOvertimePay:ot,
    totalNightWage:nwage, totalNightOvertimePay:not,
    totalTransportFee:tr,
    grandTotal:wage+ot+nwage+not+tr, records:recs};
}

/* 期間内の支払額を集計する（従業員へ渡す明細用） */
function payReport(emp,start,end){
  const recs=recordsInPeriod(emp.id,start,end);
  let att=0,natt=0,wage=0,ot=0,nwage=0,not=0,tr=0;
  recs.forEach(r=>{
    const t=payTotal(r,emp);
    att+=safeNum(r.attendance,INPUT_MAX.attendance);
    natt+=safeNum(r.nightAttendance,INPUT_MAX.nightAttendance);
    wage+=t.wage;ot+=t.ot;nwage+=t.nwage;not+=t.not;tr+=t.tr;
  });
  return {employeeId:emp.id,totalAttendance:att,totalNightAttendance:natt,
    totalDailyWage:wage,totalOvertimePay:ot,totalNightWage:nwage,totalNightOvertimePay:not,
    totalTransportFee:tr,grandTotal:wage+ot+nwage+not+tr,records:recs};
}

/* ---------- 請求番号 ---------- */
function nextInvoiceNumber(log,year){
  const re=new RegExp(`^${year}-(\\d{6})$`);
  let max=0;
  (Array.isArray(log)?log:[]).forEach(o=>{const m=String(o&&o.invoiceNo||'').match(re);if(m)max=Math.max(max,Number(m[1]));});
  return `${year}-${String(max+1).padStart(6,'0')}`;
}

/* ---------- backup validation（STATEへ触る前に全件検査） ---------- */
const BACKUP_SCHEMA_VERSION=1;
function backupFail(msg){throw new Error(msg);}
function backupObj(v,label){if(!v||typeof v!=='object'||Array.isArray(v))backupFail(`${label}の形式が不正です`);return v;}
function backupText(v,label,max=500){
  if(v==null)return '';
  if(typeof v!=='string')backupFail(`${label}は文字列ではありません`);
  if(v.length>max)backupFail(`${label}が長すぎます`);
  return v;
}
function backupNoMarkup(v,label,max=120){const s=backupText(v,label,max);if(/[<>]/.test(s))backupFail(`${label}に使用できない文字があります`);return s;}
function backupId(v,label){if(typeof v!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(v))backupFail(`${label}のIDが不正です`);return v;}
function backupNum(v,label,min,max){const n=Number(v);if(!Number.isFinite(n)||n<min||n>max)backupFail(`${label}の数値が範囲外です`);return n;}
function backupDate(v,label){
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))backupFail(`${label}の日付形式が不正です`);
  const [y,m,d]=v.split('-').map(Number),dt=new Date(v+'T00:00:00Z');
  if(!Number.isFinite(dt.getTime())||dt.getUTCFullYear()!==y||dt.getUTCMonth()+1!==m||dt.getUTCDate()!==d)backupFail(`${label}に存在しない日付があります`);
  return v;
}
function backupEffectiveDate(v,label){return v==='0000-01-01'?v:backupDate(v,label);}
function normalizeBackupSettings(raw,legacy=false){
  const s=raw==null?{}:backupObj(raw,'設定'),issuer=s.issuer==null?{}:backupObj(s.issuer,'発行者設定');
  const client=s.client==null?{}:backupObj(s.client,'請求先設定'),bank=s.bank==null?{}:backupObj(s.bank,'振込先設定');
  const tax=backupNum(s.taxRate??DEFAULT_SETTINGS.taxRate,'消費税率',0,100);
  if(!legacy&&![0,8,10].includes(tax))backupFail('消費税率は 0・8・10% のいずれかにしてください');
  const closing=backupNum(s.closingDay??DEFAULT_SETTINGS.closingDay,'締め日',1,31);
  if(!Number.isInteger(closing)||(!legacy&&closing>28&&closing!==31))backupFail('締め日が不正です');
  return {defaultTransportFee:backupNum(s.defaultTransportFee??DEFAULT_SETTINGS.defaultTransportFee,'車代の初期値',0,legacy?1000000000000:INPUT_MAX.transportFee),
    taxRate:tax,closingDay:closing,monthlyGoal:backupNum(s.monthlyGoal??DEFAULT_SETTINGS.monthlyGoal,'月間目標',0,legacy?Number.MAX_SAFE_INTEGER:1000000000000),
    issuer:{companyName:backupText(issuer.companyName,'自社名',200),postalCode:backupText(issuer.postalCode,'自社郵便番号',40),
      address:backupText(issuer.address,'自社住所',500),phone:backupText(issuer.phone,'電話番号',100),invoiceNumber:backupNoMarkup(issuer.invoiceNumber,'登録番号',100)},
    client:{companyName:backupText(client.companyName,'請求先名',200),postalCode:backupText(client.postalCode,'請求先郵便番号',40),
      address:backupText(client.address,'請求先住所',500),contactName:backupText(client.contactName,'担当者名',200)},
    bank:{bankName:backupText(bank.bankName,'銀行名',200),branchName:backupText(bank.branchName,'支店名',200),
      accountType:backupText(bank.accountType??DEFAULT_SETTINGS.bank.accountType,'口座種別',40),accountNumber:backupText(bank.accountNumber,'口座番号',100),accountHolder:backupText(bank.accountHolder,'口座名義',200)}};
}
function normalizeBackupEmployee(raw,label,legacy=false){
  const e=backupObj(raw,label),id=backupId(e.id,label),name=backupText(e.name,`${label}の名前`,200);
  if(!name.trim())backupFail(`${label}の名前が空です`);
  const wageMax=legacy?1000000000000:WAGE_MAX;
  const out={id,name,dailyWage:backupNum(e.dailyWage,`${name}の日給`,legacy?0:1,wageMax),nightWage:backupNum(e.nightWage??0,`${name}の夜間単価`,0,wageMax),
    payWage:backupNum(e.payWage??0,`${name}の支払日給`,0,wageMax),payNightWage:backupNum(e.payNightWage??0,`${name}の支払夜間単価`,0,wageMax),
    createdAt:backupText(e.createdAt,`${name}の作成日時`,100)};
  if(e.wageHistory==null){out.wageHistory=null;return out;}
  if(!Array.isArray(e.wageHistory)||e.wageHistory.length>1000)backupFail(`${name}の単価履歴形式が不正です`);
  const dates=new Set();
  out.wageHistory=e.wageHistory.map((rawRate,i)=>{
    const r=backupObj(rawRate,`${name}の単価履歴${i+1}件目`),from=backupEffectiveDate(r.from,`${name}の単価履歴${i+1}件目`);
    if(dates.has(from))backupFail(`${name}の単価履歴の適用日が重複しています: ${from}`);dates.add(from);
    return {from,dailyWage:backupNum(r.dailyWage,`${name}の履歴日給`,legacy?0:1,wageMax),nightWage:backupNum(r.nightWage??0,`${name}の履歴夜間単価`,0,wageMax),
      payWage:backupNum(r.payWage??0,`${name}の履歴支払日給`,0,wageMax),payNightWage:backupNum(r.payNightWage??0,`${name}の履歴支払夜間単価`,0,wageMax)};
  }).sort((a,b)=>a.from<b.from?-1:a.from>b.from?1:0);
  return out;
}
function normalizeBackupRecord(raw,label,employeeIds,expectedEmployeeId,legacy=false){
  const r=backupObj(raw,label),id=backupId(r.id,label),employeeId=backupId(r.employeeId,`${label}の従業員`);
  if(expectedEmployeeId&&employeeId!==expectedEmployeeId)backupFail(`${label}の従業員IDが一致しません`);
  if(employeeIds&&!employeeIds.has(employeeId))backupFail(`${label}が存在しない従業員を参照しています`);
  const oldCountMax=100000,oldMoneyMax=1000000000000;
  const rec={id,employeeId,date:backupDate(r.date,label),attendance:backupNum(r.attendance??0,`${label}の出勤数`,0,INPUT_MAX.attendance),
    overtimeHours:backupNum(r.overtimeHours??0,`${label}の残業時間`,0,legacy?oldCountMax:INPUT_MAX.overtimeHours),nightAttendance:backupNum(r.nightAttendance??0,`${label}の夜勤出勤数`,0,INPUT_MAX.nightAttendance),
    nightOvertimeHours:backupNum(r.nightOvertimeHours??0,`${label}の夜間残業`,0,legacy?oldCountMax:INPUT_MAX.nightOvertimeHours),transportFee:backupNum(r.transportFee??0,`${label}の車代`,0,legacy?oldMoneyMax:INPUT_MAX.transportFee),
    transportToWorker:r.transportToWorker===true};
  if(r.transportToWorker!=null&&typeof r.transportToWorker!=='boolean')backupFail(`${label}の車代支払設定が不正です`);
  if(r.manualTotal!=null)rec.manualTotal=backupNum(r.manualTotal,`${label}の手入力合計`,0,legacy?oldMoneyMax:INPUT_MAX.manualTotal);
  if(r.note!=null)rec.note=backupText(r.note,`${label}のメモ`,2000);
  return rec;
}
function normalizeBackupSnapshot(raw,index,legacy){
  const s=backupObj(raw,`発行履歴${index+1}件目のスナップショット`);
  if(!s.settings||!Array.isArray(s.reports)||s.reports.length>5000)backupFail(`発行履歴${index+1}件目のスナップショット形式が不正です`);
  if(JSON.stringify(s).length>5000000)backupFail(`発行履歴${index+1}件目のスナップショットが大きすぎます`);
  const settings=normalizeBackupSettings(s.settings,legacy);
  const reports=s.reports.map((rawReport,ri)=>{
    const label=`発行履歴${index+1}件目の明細${ri+1}件目`,item=backupObj(rawReport,label),emp=normalizeBackupEmployee(item.emp,`${label}の従業員`,legacy);
    const rr=backupObj(item.rep,`${label}の集計`),employeeId=backupId(rr.employeeId,`${label}の集計従業員`);
    if(employeeId!==emp.id||!Array.isArray(rr.records)||rr.records.length>1000)backupFail(`${label}の勤怠明細形式が不正です`);
    const ids=new Set(),dates=new Set();
    const records=rr.records.map((x,rj)=>{const r=normalizeBackupRecord(x,`${label}の勤怠${rj+1}件目`,null,emp.id,legacy);
      if(!legacy&&ids.has(r.id))backupFail(`${label}の勤怠IDが重複しています: ${r.id}`);ids.add(r.id);
      if(!legacy&&dates.has(r.date))backupFail(`${label}で同じ日の勤怠が重複しています: ${r.date}`);dates.add(r.date);return r;});
    const expected={totalAttendance:0,totalNightAttendance:0,totalDailyWage:0,totalOvertimePay:0,totalNightWage:0,totalNightOvertimePay:0,totalTransportFee:0};
    records.forEach(r=>{const t=dailyTotal(r,emp);expected.totalAttendance+=r.attendance||0;expected.totalNightAttendance+=r.nightAttendance||0;
      if(t.overridden)expected.totalDailyWage+=t.total;else{expected.totalDailyWage+=t.wage;expected.totalOvertimePay+=t.ot;expected.totalNightWage+=t.nwage;expected.totalNightOvertimePay+=t.not;expected.totalTransportFee+=t.tr;}});
    const money=(v,n)=>backupNum(v??0,`${label}の${n}`,0,1000000000000);
    const rep={employeeId,totalAttendance:backupNum(rr.totalAttendance??0,`${label}の日勤出勤数`,0,100000),totalNightAttendance:backupNum(rr.totalNightAttendance??0,`${label}の夜勤出勤数`,0,100000),
      totalDailyWage:money(rr.totalDailyWage,'日勤人工代'),totalOvertimePay:money(rr.totalOvertimePay,'日勤残業代'),totalNightWage:money(rr.totalNightWage,'夜勤人工代'),
      totalNightOvertimePay:money(rr.totalNightOvertimePay,'夜勤残業代'),totalTransportFee:money(rr.totalTransportFee,'車代'),grandTotal:money(rr.grandTotal,'合計'),records};
    expected.grandTotal=expected.totalDailyWage+expected.totalOvertimePay+expected.totalNightWage+expected.totalNightOvertimePay+expected.totalTransportFee;
    if(rep.grandTotal!==rep.totalDailyWage+rep.totalOvertimePay+rep.totalNightWage+rep.totalNightOvertimePay+rep.totalTransportFee)backupFail(`${label}の内訳合計と合計金額が一致しません`);
    if(!legacy)Object.entries(expected).forEach(([k,v])=>{if(rep[k]!==v)backupFail(`${label}の集計値が勤怠明細と一致しません (${k})`);});
    return {emp,rep};
  });
  return {settings,reports};
}
function normalizeBackupIssue(raw,index,legacy){
  const o=backupObj(raw,`発行履歴${index+1}件目`),period=backupObj(o.period,`発行履歴${index+1}件目の期間`);
  const issuedAt=backupText(o.issuedAt,`発行履歴${index+1}件目の発行日時`,80);if(!Number.isFinite(Date.parse(issuedAt)))backupFail(`発行履歴${index+1}件目の発行日時が不正です`);
  const start=backupDate(period.start,`発行履歴${index+1}件目の開始日`),end=backupDate(period.end,`発行履歴${index+1}件目の終了日`);if(start>end)backupFail(`発行履歴${index+1}件目の期間が逆転しています`);
  const snapshot=o.snapshot==null?null:normalizeBackupSnapshot(o.snapshot,index,legacy);
  const subtotal=backupNum(o.subtotal,`発行履歴${index+1}件目の小計`,-1000000000000,1000000000000),tax=backupNum(o.tax,`発行履歴${index+1}件目の税額`,-1000000000000,1000000000000);
  const taxRate=backupNum(o.taxRate,`発行履歴${index+1}件目の税率`,0,100),total=backupNum(o.total,`発行履歴${index+1}件目の合計`,-1000000000000,1000000000000);
  if(snapshot){
    const snapSubtotal=snapshot.reports.reduce((sum,x)=>sum+x.rep.grandTotal,0);
    if(subtotal!==snapSubtotal||taxRate!==snapshot.settings.taxRate||tax!==calcTax(subtotal,taxRate)||total!==subtotal+tax)backupFail(`発行履歴${index+1}件目の金額がスナップショットと一致しません`);
    const expectedClient=snapshot.settings.client.companyName||'（請求先未設定）',expectedIssuer=snapshot.settings.issuer.companyName||'';
    if(o.clientName!==expectedClient||o.issuerName!==expectedIssuer)backupFail(`発行履歴${index+1}件目の取引先または発行者がスナップショットと一致しません`);
    snapshot.reports.forEach((x,ri)=>x.rep.records.forEach((r,rj)=>{if(r.date<start||r.date>end)backupFail(`発行履歴${index+1}件目の明細${ri+1}件目の勤怠${rj+1}件目が請求期間外です`);}));
  }
  return {id:backupId(o.id,`発行履歴${index+1}件目`),issuedAt,invoiceNo:backupNoMarkup(o.invoiceNo,`発行履歴${index+1}件目の請求番号`,120),
    issueDate:backupNoMarkup(o.issueDate,`発行履歴${index+1}件目の発行日`,80),period:{start,end,label:backupNoMarkup(period.label,`発行履歴${index+1}件目の期間表示`,120),periodLabel:backupNoMarkup(period.periodLabel,`発行履歴${index+1}件目の請求月表示`,80)},
    clientName:backupText(o.clientName,`発行履歴${index+1}件目の取引先`,300),issuerName:backupText(o.issuerName,`発行履歴${index+1}件目の発行者`,300),subtotal,tax,taxRate,total,
    batch:!!o.batch,voided:!!o.voided,voidReason:backupText(o.voidReason,`発行履歴${index+1}件目の取消理由`,1000),
    ...(o.voidOperator?{voidOperator:backupText(o.voidOperator,`発行履歴${index+1}件目の取消担当者`,200)}:{}),
    ...(o.voidedAt?{voidedAt:backupText(o.voidedAt,`発行履歴${index+1}件目の取消日時`,80)}:{}),...(o.voidOf?{voidOf:backupId(o.voidOf,`発行履歴${index+1}件目の取消元`)}:{}),snapshot};
}
function validateBackupPayload(raw){
  const o=backupObj(raw,'バックアップ');if(o.schemaVersion!=null&&Number(o.schemaVersion)!==BACKUP_SCHEMA_VERSION)backupFail('このバックアップ形式は現在のアプリでは復元できません');
  if(!Array.isArray(o.employees)||!Array.isArray(o.records))backupFail('従業員または勤怠データが見つかりません');
  const invoiceRaw=o.invoiceLog==null?[]:o.invoiceLog;if(!Array.isArray(invoiceRaw))backupFail('発行履歴の形式が不正です');
  if(o.employees.length>5000||o.records.length>500000||invoiceRaw.length>100000)backupFail('バックアップの件数が上限を超えています');
  const legacy=o.schemaVersion==null,empIds=new Set();
  const employees=o.employees.map((x,i)=>{const e=normalizeBackupEmployee(x,`従業員${i+1}件目`,legacy);if(empIds.has(e.id))backupFail(`従業員IDが重複しています: ${e.id}`);empIds.add(e.id);return e;});
  const recordIds=new Set(),days=new Set();
  const records=o.records.map((x,i)=>{const r=normalizeBackupRecord(x,`勤怠${i+1}件目`,empIds,null,legacy);if(recordIds.has(r.id))backupFail(`勤怠IDが重複しています: ${r.id}`);recordIds.add(r.id);
    const key=`${r.employeeId}|${r.date}`;if(days.has(key))backupFail(`同じ従業員・同じ日の勤怠が重複しています: ${r.date}`);days.add(key);return r;});
  const logIds=new Set(),invoiceLog=invoiceRaw.map((x,i)=>{const issue=normalizeBackupIssue(x,i,legacy);if(logIds.has(issue.id))backupFail(`発行履歴IDが重複しています: ${issue.id}`);logIds.add(issue.id);return issue;});
  const logById=new Map(invoiceLog.map(x=>[x.id,x])),cancelled=new Set();
  invoiceLog.forEach((issue,i)=>{if(!legacy&&!issue.snapshot&&!issue.voidOf)backupFail(`発行履歴${i+1}件目にスナップショットがありません`);if(!issue.voidOf)return;const original=logById.get(issue.voidOf);if(!original||original.id===issue.id||original.voidOf)backupFail(`発行履歴${i+1}件目の取消参照が不正です`);
    if(cancelled.has(original.id))backupFail(`同じ発行履歴に複数の取消記録があります: ${original.id}`);cancelled.add(original.id);
    if(issue.subtotal!==-original.subtotal||issue.tax!==-original.tax||issue.total!==-original.total||issue.taxRate!==original.taxRate)backupFail(`発行履歴${i+1}件目の取消金額が元の記録と一致しません`);});
  return {schemaVersion:BACKUP_SCHEMA_VERSION,employees,records,settings:normalizeBackupSettings(o.settings,legacy),invoiceLog};
}

/* 発行履歴は追記のみの記録なので、復元で置き換えず両方を残す。
   ただし取消の整合（1つの記録に取消は1件、取消元が存在する）は崩さない。
   崩すものは足さずに捨てる。記録を増やすために整合を壊しては本末転倒なので。 */
function mergeInvoiceLogs(current,incoming){
  const out=(Array.isArray(current)?current:[]).slice();
  const byId=new Map(out.map(l=>[l&&l.id,l]));
  const cancelled=new Set(out.filter(l=>l&&l.voidOf).map(l=>l.voidOf));
  (Array.isArray(incoming)?incoming:[]).forEach(l=>{
    if(!l||!l.id||byId.has(l.id))return;
    if(l.voidOf){
      const orig=byId.get(l.voidOf);
      if(!orig||orig.voidOf||cancelled.has(l.voidOf))return;
      cancelled.add(l.voidOf);
    }
    out.push(l);byId.set(l.id,l);
  });
  return out.sort((a,b)=>String((a&&a.issuedAt)||'')<String((b&&b.issuedAt)||'')?-1:1);
}

/* ---------- BOOT ---------- */
window.addEventListener('load',boot);
async function boot(){
  try{if(navigator.storage&&navigator.storage.persist){if(!(await navigator.storage.persisted()))await navigator.storage.persist();}}catch(e){}
  try{
    const [emps,recs,set,ready,ilog]=await Promise.all([idbGet('employees'),idbGet('records'),idbGet('settings'),idbGet('ready'),idbGet('invoiceLog')]);
    if(emps)STATE.employees=emps;
    if(recs)STATE.records=recs;
    if(set)STATE.settings=mergeSettings(set);
    if(ready)STATE.ready=ready;
    if(Array.isArray(ilog))STATE.invoiceLog=ilog;
    const ulog=await idbGet('usageLog');
    if(Array.isArray(ulog))STATE.usageLog=ulog;
    const dest=await idbGet('reportDest');
    if(dest&&typeof dest==='object')STATE.reportDest={
      url:String(dest.url||''),key:String(dest.key||''),
      auto:!!dest.auto,autoData:!!dest.autoData,
      touched:!!dest.touched,
      lastAt:Number(dest.lastAt)||0,lastSig:String(dest.lastSig||''),
      device:String(dest.device||'')};
    // 使う人が自分で書き換えていなければ、アプリに埋め込んだ送信先を使う。
    // こうしておくと、あとで送信先を変えてもアプリの更新だけで行き渡る。
    if(!STATE.reportDest.touched){
      STATE.reportDest.url=DEFAULT_REPORT.url;
      STATE.reportDest.key=DEFAULT_REPORT.key;
      // 送信先が埋め込まれていないうちは自動送信をONに見せない
      STATE.reportDest.auto=!!DEFAULT_REPORT.url&&DEFAULT_REPORT.auto;
      STATE.reportDest.autoData=DEFAULT_REPORT.autoData;
    }
    if(!ready) await migrate();
  }catch(e){toast('⚠️ データ読込エラー');}
  invalidateIdx();
  // 更新の検出。以前は register するだけで、新しい版が出ても端末が気づかず
  // 「アップデートされない」状態になっていた。
  if('serviceWorker'in navigator){try{
    const reg=await navigator.serviceWorker.register('sw.js');
    // 新しい版を見つけたら、待たせずに切り替えさせる
    reg.addEventListener('updatefound',()=>{
      const w=reg.installing;if(!w)return;
      w.addEventListener('statechange',()=>{
        if(w.state==='installed'&&navigator.serviceWorker.controller)w.postMessage('skipWaiting');
      });
    });
    // 新しい版が主導権を取ったら一度だけ読み込み直す
    let reloaded=false;
    navigator.serviceWorker.addEventListener('controllerchange',()=>{
      if(reloaded)return;reloaded=true;location.reload();
    });
    reg.update();
    // ホーム画面から復帰したときも確認する（iOSはここが弱く、古いまま居座りやすい）
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)reg.update().catch(()=>{});});
  }catch(e){}}
  $('ver').textContent=APP_VERSION;
  buildClosingOptions();
  loadSettingsForm();
  loadReportDest();
  if(STATE.employees.length) selEmp=STATE.employees[0].id;
  // ロゴの描画アニメーションを見せてから閉じる。待ちたくない人はタップで飛ばせる
  const sp=$('splash');
  const hideSplash=()=>sp.classList.add('hide');
  setTimeout(hideSplash,1500);
  sp.addEventListener('pointerdown',hideSplash,{once:true});
  logUse('起動',APP_VERSION+' / '+(navigator.standalone?'ホーム画面':'ブラウザ'));
  renderAll();
  switchTab('home');
  startAutoReport();
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
/* タブ切替の遷移は transform/opacity だけで作る（合成のみ＝GPU）。
   View Transitions API は同じ見た目でも1回あたり約55ms要したため使わない（実測）。
   金額カードの移動は FLIP（位置差を transform で埋めてアニメーション）で表現する。 */
const TAB_ORDER=['home','att','bill','set'];
let curTab='home';
function reduceMotion(){return matchMedia('(prefers-reduced-motion: reduce)').matches;}
/* 各ページの「主役の金額カード」。タブをまたいで動いて見せる対象 */
function heroOf(page){return page?page.querySelector('.dash-hero,.grand,.runbar'):null;}
function applyTab(t){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tb').forEach(b=>{b.classList.remove('active');b.removeAttribute('aria-current');});
  $('page-'+t).classList.add('active');
  $('tb-'+t).classList.add('active');
  $('tb-'+t).setAttribute('aria-current','page');
  const cfg={home:['ホーム','DASHBOARD',false],att:['日給管理','ATTENDANCE',true],bill:['請求','INVOICE',false],set:['設定','SETTINGS',false]};
  $('ph-name').textContent=cfg[t][0]; $('ph-sub').textContent=cfg[t][1];
  $('ph-month').style.display=cfg[t][2]?'flex':'none';
}
/* 重い描画は遷移を始める前に済ませる（2つのスナップショット取得の間で main thread を止めない） */
function prepareTab(t){
  if(t==='att'&&attDirty){attDirty=false;renderAtt();}
  if(t==='home')renderDash();
  if(t==='bill')renderBill();
  if(t==='set')renderSettingsLists();
}
function switchTab(t){
  logUse('tab',t);
  // 請求タブまで来たのに請求書を作らずに離れたなら、そこで止まっている
  if(t==='bill')noteOpen('請求タブ（作らず離脱）');
  else if(curTab==='bill')noteClosed('請求タブ（作らず離脱）');
  const from=TAB_ORDER.indexOf(curTab),to=TAB_ORDER.indexOf(t);
  const same=(from===to),back=(to<from);
  curTab=t;
  const anim=!same&&from>=0&&to>=0&&!reduceMotion();
  // FLIP: 切替前のカード位置を控えておく
  const prevHero=anim?heroOf(document.querySelector('.page.active')):null;
  const first=prevHero?prevHero.getBoundingClientRect():null;

  prepareTab(t);   // 重い描画は遷移アニメーションを始める前に済ませる
  applyTab(t);

  if(!anim)return;
  const pg=$('page-'+t);
  pg.classList.remove('pg-in','pg-in-back');
  void pg.offsetWidth;                       // アニメーションを確実に再生させる
  pg.classList.add(back?'pg-in-back':'pg-in');

  // FLIP: 新しい位置との差を transform で埋めてから 0 に戻す（合成のみで動く）
  const nextHero=heroOf(pg);
  if(first&&nextHero&&nextHero.animate){
    const last=nextHero.getBoundingClientRect();
    const dx=first.left-last.left, dy=first.top-last.top;
    if(Math.abs(dx)>2||Math.abs(dy)>2){
      nextHero.animate(
        [{transform:`translate3d(${dx}px,${dy}px,0)`},{transform:'translate3d(0,0,0)'}],
        {duration:280,easing:'cubic-bezier(.22,.68,.32,1)'}
      );
    }
  }
}
window.switchTab=switchTab;
$('tb-home').addEventListener('click',()=>switchTab('home'));
$('tb-att').addEventListener('click',()=>switchTab('att'));
$('tb-bill').addEventListener('click',()=>switchTab('bill'));
$('tb-set').addEventListener('click',()=>switchTab('set'));

/* ---------- month nav (header, 勤怠タブ) ---------- */
$('hm-prev').addEventListener('click',()=>{if(viewM===1){viewM=12;viewY--;}else viewM--;renderAtt();});
$('hm-next').addEventListener('click',()=>{if(viewM===12){viewM=1;viewY++;}else viewM++;renderAtt();});
function updateHeaderMonth(){$('hm-label').textContent=`${viewY}年${viewM}月`;}

/* ---------- RENDER ALL ---------- */
function renderAll(){updateHeaderMonth();renderEmpRow();renderAtt();}

/* ===== ホーム（ダッシュボード） ===== */
const CHART_BLUE='#3f5fa7', CHART_AMBER='#d97e06'; // 配色はCVD/コントラスト検証済み
function monthKey(ds){return ds.slice(0,7);}
function monthTotalsMap(){
  const map=new Map(); // 'YYYY-MM' -> 合計
  const {empById}=idx();
  canonicalRecords().forEach(r=>{
    if(!recHasData(r))return;
    const emp=empById.get(r.employeeId);
    if(!emp)return;
    const k=monthKey(r.date);
    map.set(k,(map.get(k)||0)+dailyTotal(r,emp).total);
  });
  return map;
}
/* 万単位の短い表記（軸ラベル・統計タイル用） */
function fmtMan(v){
  v=Math.round(v||0);
  if(v===0)return '0';
  if(v<10000)return v.toLocaleString('ja-JP');
  const man=v/10000;
  return (man>=100?Math.round(man):Math.round(man*10)/10)+'万';
}
function niceCeil(v){
  if(v<=0)return 1;
  const p=Math.pow(10,Math.floor(Math.log10(v)));
  const n=v/p;
  const f=n<=1?1:n<=2?2:n<=2.5?2.5:n<=5?5:10;
  return f*p;
}
/* 上端だけ角丸・ベースラインは直角のバー */
function barPath(x,y,w,h,r){
  if(h<=0)return '';
  r=Math.min(r,h,w/2);
  const x2=x+w,yb=y+h;
  return `M${x} ${yb} L${x} ${y+r} Q${x} ${y} ${x+r} ${y} L${x2-r} ${y} Q${x2} ${y} ${x2} ${y+r} L${x2} ${yb} Z`;
}
let dashMonths=[]; // 直近12ヶ月 [{key,y,m,total}]
/* グラフのレイアウト定数は1箇所に集約する（描画とツールチップで二重定義するとズレる） */
const CHART={W:344,H:170,padL:34,padR:6,padT:16,padB:18,n:12};
CHART.bandW=(CHART.W-CHART.padL-CHART.padR)/CHART.n;
function chartBandCenter(i){return CHART.padL+i*CHART.bandW+CHART.bandW/2;}
/* グラフ共通の定義。文書に1つだけ置き、各SVGからidで参照する。
   SVGごとにdefsを複製するとID衝突と再ラスタライズでタブ切替が重くなる（実測でp90が+40ms）。
   ぼかしフィルタ（feGaussianBlur）も同じ理由で使わず、グラデーションの明度で発光を表現する。 */
function chartDefsOnce(){
  return `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
    <linearGradient id="gBar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#6484d6"/><stop offset="1" stop-color="#2e4a8c"/>
    </linearGradient>
    <linearGradient id="gCur" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffc24d"/><stop offset="1" stop-color="#d97e06"/>
    </linearGradient>
    <linearGradient id="gArea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4f74c8" stop-opacity=".42"/>
      <stop offset="1" stop-color="#4f74c8" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="gRing" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#3f5fa7"/><stop offset=".6" stop-color="#6c8ee0"/><stop offset="1" stop-color="#ffc24d"/>
    </linearGradient>
  </defs></svg>`;
}
/* 点列を滑らかな曲線に変換（Catmull-Rom を3次ベジェへ） */
function smoothPath(pts){
  if(pts.length<2)return '';
  let d=`M${pts[0][0]} ${pts[0][1]}`;
  for(let i=0;i<pts.length-1;i++){
    const p0=pts[i-1]||pts[i],p1=pts[i],p2=pts[i+1],p3=pts[i+2]||pts[i+1];
    const c1x=p1[0]+(p2[0]-p0[0])/6, c1y=p1[1]+(p2[1]-p0[1])/6;
    const c2x=p2[0]-(p3[0]-p1[0])/6, c2y=p2[1]-(p3[1]-p1[1])/6;
    d+=` C${c1x.toFixed(1)} ${c1y.toFixed(1)},${c2x.toFixed(1)} ${c2y.toFixed(1)},${p2[0]} ${p2[1]}`;
  }
  return d;
}
function buildBarChart(){
  const {W,H,padL,padR,padT,padB}=CHART;
  const plotW=W-padL-padR,plotH=H-padT-padB;
  const yMax=niceCeil(Math.max(...dashMonths.map(m=>m.total),1));
  const ys=v=>padT+plotH-(v/yMax*plotH);
  const bandW=CHART.bandW;
  const barW=Math.min(20,bandW-6);
  let grid='',bars='',labels='',hits='';
  [0,yMax/2,yMax].forEach(t=>{
    const y=ys(t);
    grid+=`<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="#e7ebf2" stroke-width="1"/>`;
    grid+=`<text x="${padL-5}" y="${y+3}" text-anchor="end" font-size="8.5" fill="#97a0af">${fmtMan(t)}</text>`;
  });
  dashMonths.forEach((m,i)=>{
    const x=padL+i*bandW+(bandW-barW)/2;
    const h=m.total/yMax*plotH;
    const y=padT+plotH-h;
    const curM=(i===11);
    if(m.total>0)
      bars+=`<path class="bar${animClass('anim')}" style="animation-delay:${i*35}ms" d="${barPath(x,y,barW,h,4)}" fill="url(#${curM?'gCur':'gBar'})"/>`;
    labels+=`<text x="${chartBandCenter(i)}" y="${H-5}" text-anchor="middle" font-size="8.5" fill="${curM?'#5d6675':'#97a0af'}" font-weight="${curM?'700':'400'}">${m.m}月</text>`;
    if(curM&&m.total>0)
      labels+=`<text x="${chartBandCenter(i)}" y="${y-5}" text-anchor="middle" font-size="9.5" font-weight="700" fill="#5d6675">${fmtMan(m.total)}</text>`;
    hits+=`<rect x="${padL+i*bandW}" y="${padT}" width="${bandW}" height="${plotH}" fill="transparent" onclick="dashTip(${i})"><title>${m.y}年${m.m}月 ${yen(m.total)}</title></rect>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="月別売上の棒グラフ"><g>${grid}</g><g class="bars">${bars}</g><g>${labels}</g><g>${hits}</g></svg>`;
}
/* 今月の日別累計（棒グラフとは別の切り口：月がどう積み上がっているか） */
function monthCumulative(Y,M){
  const {empById}=idx();
  const pad=pad2, km=`${Y}-${pad(M)}`;
  const byDay=new Map();
  canonicalRecords().forEach(r=>{
    if(!r.date.startsWith(km)||!recHasData(r))return;
    const emp=empById.get(r.employeeId);
    if(!emp)return;
    const d=+r.date.slice(8,10);
    byDay.set(d,(byDay.get(d)||0)+dailyTotal(r,emp).total);
  });
  const dim=new Date(Y,M,0).getDate();
  const today=new Date();
  const upto=(today.getFullYear()===Y&&today.getMonth()+1===M)?today.getDate():dim;
  const out=[];let acc=0;
  for(let d=1;d<=upto;d++){acc+=byDay.get(d)||0;out.push({d,acc});}
  return {points:out,dim,total:acc};
}
/* 今月の積み上がりを滑らかな曲線＋グラデーション塗りで描く */
function buildAreaChart(Y,M,goal){
  const W=344,H=124,padL=6,padR=6,padT=12,padB=18;
  const {points,dim}=monthCumulative(Y,M);
  if(points.length<2)return '';
  const plotW=W-padL-padR,plotH=H-padT-padB;
  // 目標も収まる縦軸にする（月末までの空白に「目標ペース」の意味を持たせる）
  const yMax=niceCeil(Math.max(...points.map(p=>p.acc),goal||0,1));
  const px=d=>padL+(d-1)/(dim-1)*plotW;
  const py=v=>padT+plotH-(v/yMax*plotH);
  const pts=points.map(p=>[+px(p.d).toFixed(1),+py(p.acc).toFixed(1)]);
  const line=smoothPath(pts);
  const area=`${line} L${pts[pts.length-1][0]} ${padT+plotH} L${pts[0][0]} ${padT+plotH} Z`;
  const last=pts[pts.length-1];
  const lastVal=points[points.length-1].acc;
  let grid='';
  [0,yMax].forEach(t=>{const y=py(t);
    grid+=`<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="#e7ebf2" stroke-width="1"/>`;});
  // 目標ペース：月初0から月末に目標へ届く直線。今の位置が先行/遅れか一目で分かる
  const pace=goal>0?`<line x1="${px(1)}" y1="${py(0)}" x2="${px(dim)}" y2="${py(goal)}"
      stroke="#b9c6de" stroke-width="1.6" stroke-dasharray="4 4"/>
    <text x="${W-padR}" y="${py(goal)-5}" text-anchor="end" font-size="8.5" fill="#6c7585">目標ペース</text>`:'';
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="今月の売上の積み上がりと目標ペース">
    <g>${grid}</g>${pace}
    <path d="${area}" fill="url(#gArea)" class="area-fill${animClass('anim')}"/>
    <path d="${line}" fill="none" stroke="#4f74c8" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="area-line${animClass('anim')}"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="4.2" fill="#fff" stroke="#4f74c8" stroke-width="2.4"/>
    <text x="${Math.min(W-padR-4,Math.max(padL+22,last[0]))}" y="${Math.max(11,last[1]-10)}" text-anchor="middle" font-size="9.5" font-weight="700" fill="#4d5566">${fmtMan(lastVal)}</text>
    <text x="${padL}" y="${H-5}" font-size="8.5" fill="#6c7585">1日</text>
    <text x="${W-padR}" y="${H-5}" text-anchor="end" font-size="8.5" fill="#6c7585">${dim}日</text>
  </svg>`;
}
/* 月間目標に対する達成率のリングゲージ。
   軌道は同じ色相の淡い段階（dataviz のメーター規則）にする */
function buildRing(cur,goal){
  const S=104,cx=S/2,cy=S/2,r=41,c=2*Math.PI*r;
  const p=goal>0?Math.min(1.35,cur/goal):0;
  const off=c*(1-Math.min(1,p));
  const pct=goal>0?Math.round(cur/goal*100):0;
  return `<svg viewBox="0 0 ${S} ${S}" class="ring" role="img" aria-label="月間目標の達成率 ${pct}パーセント">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#dde5f3" stroke-width="9"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="url(#gRing)" stroke-width="9" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"
      transform="rotate(-90 ${cx} ${cy})" class="ring-fill${animClass('anim')}"/>
    <text x="${cx}" y="${cy-1}" text-anchor="middle" font-size="21" font-weight="800" fill="#141a26">${pct}</text>
    <text x="${cx}" y="${cy+14}" text-anchor="middle" font-size="9" font-weight="700" fill="#6c7585">%</text>
  </svg>`;
}

/* ---------- 空状態のイラスト（職人・現場のモチーフ）---------- */
const ART={
  // ヘルメットと工具：まだ誰も登録されていない状態
  att:`<svg class="art" viewBox="0 0 160 116" aria-hidden="true">
    <ellipse cx="80" cy="103" rx="52" ry="7" fill="#e3e9f4"/>
    <path d="M34 78a46 46 0 0 1 92 0z" fill="#dfe7f6" stroke="#9fb3d9" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="M80 32v-6M62 40l-4-5M98 40l4-5" stroke="#b9c8e6" stroke-width="2.4" stroke-linecap="round"/>
    <path d="M68 78V52a12 12 0 0 1 24 0v26" fill="#f3f6fc" stroke="#9fb3d9" stroke-width="2.4"/>
    <rect x="26" y="78" width="108" height="9" rx="4.5" fill="#c9d6ee"/>
    <path d="M52 96l14-14M108 96L94 82" stroke="#e0a63f" stroke-width="3.4" stroke-linecap="round"/>
  </svg>`,
  // 請求書と鉛筆：この期間のデータがない状態
  bill:`<svg class="art" viewBox="0 0 160 116" aria-hidden="true">
    <ellipse cx="80" cy="104" rx="48" ry="6.5" fill="#e3e9f4"/>
    <path d="M50 14h38l22 22v58a5 5 0 0 1-5 5H50a5 5 0 0 1-5-5V19a5 5 0 0 1 5-5z" fill="#f7f9fd" stroke="#9fb3d9" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="M88 14v22h22" fill="none" stroke="#9fb3d9" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="M58 52h34M58 63h24M58 74h30" stroke="#c3d0e8" stroke-width="3.2" stroke-linecap="round"/>
    <path d="M96 88l18-18 8 8-18 18-10 2z" fill="#fbe6c2" stroke="#e0a63f" stroke-width="2.4" stroke-linejoin="round"/>
  </svg>`,
  // 保管箱：発行履歴がまだない状態
  log:`<svg class="art" viewBox="0 0 160 116" aria-hidden="true">
    <ellipse cx="80" cy="104" rx="46" ry="6.5" fill="#e3e9f4"/>
    <path d="M38 46h84v46a5 5 0 0 1-5 5H43a5 5 0 0 1-5-5z" fill="#f2f6fc" stroke="#9fb3d9" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="M32 30h96v16H32z" fill="#dfe7f6" stroke="#9fb3d9" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="M68 62h24" stroke="#9fb3d9" stroke-width="3.2" stroke-linecap="round"/>
    <path d="M92 14l6 10 11 2-8 8 2 11-11-6-11 6 2-11-8-8 11-2z" fill="#fbe6c2" stroke="#e0a63f" stroke-width="2"/>
  </svg>`,
};

/* 統計タイル用のアイコン（線幅は既存アイコンと統一） */
const STAT_ICONS={
  att:'<svg class="ic" viewBox="0 0 24 24"><path d="M12 12.6a4.1 4.1 0 1 0 0-8.2 4.1 4.1 0 0 0 0 8.2z"/><path d="M4.6 20.4a7.4 7.4 0 0 1 14.8 0"/></svg>',
  ot:'<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12.8" r="7.9"/><path d="M12 8.6v4.2l2.9 1.8M9 2.6h6"/></svg>',
  avg:'<svg class="ic" viewBox="0 0 24 24"><path d="M3.6 16.4l4.6-5.2 3.6 3.1 3.4-4.2 5.2 5.6"/><path d="M3.6 20.4h16.8"/></svg>',
  cum:'<svg class="ic" viewBox="0 0 24 24"><path d="M4.4 7.6h15.2M4.4 12h15.2M4.4 16.4h15.2"/><path d="M8 4.4v15.2"/></svg>',
};
/* タイル内のミニ推移グラフ（直近6ヶ月）。軸も目盛りも持たない */
function sparkline(vals,accent){
  const W=140,H=20;   // タイル幅に近い比率にして横いっぱいに広げる
  if(!vals.length||Math.max(...vals)<=0)return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"></svg>`;
  const mx=Math.max(...vals),n=vals.length;
  const pts=vals.map((v,i)=>[+(i/(n-1)*W).toFixed(1),+(H-2-(v/mx)*(H-4)).toFixed(1)]);
  const line=smoothPath(pts);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <path d="${line} L${W} ${H} L0 ${H} Z" fill="${accent?'rgba(217,126,6,.16)':'rgba(63,95,167,.14)'}"/>
    <path d="${line}" fill="none" stroke="${accent?'#d97e06':'#4f74c8'}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${pts[n-1][0]-1}" cy="${pts[n-1][1]}" r="2.1" fill="${accent?'#d97e06':'#4f74c8'}"/>
  </svg>`;
}
let dashAnimated=false;   // グラフの描画アニメーションはセッション初回のみ再生する
function animClass(name){return dashAnimated?'':' '+name;}
let dashTipTimer=null;
function dashTip(i){
  const m=dashMonths[i];const tip=$('dash-tip');
  if(!m||!tip)return;
  const cx=chartBandCenter(i)/CHART.W*100;
  tip.textContent=`${m.y}年${m.m}月 ${yen(m.total)}`;
  tip.style.left=Math.min(86,Math.max(14,cx))+'%';
  tip.classList.add('show');
  haptic();
  clearTimeout(dashTipTimer);
  dashTipTimer=setTimeout(()=>tip.classList.remove('show'),2200);
}
window.dashTip=dashTip;
function renderDash(){
  const body=$('dash-body');
  if(!body)return;
  // データも表示月も変わっていないなら作り直さない（タブを行き来するたびに
  // 3つのグラフを再生成すると切替の最長フレームが伸びる）
  const now0=new Date();
  const stamp=`${now0.getFullYear()}-${now0.getMonth()+1}`;
  if(!dashDirty&&body.dataset.stamp===stamp&&body.childElementCount)return;
  body.dataset.stamp=stamp;
  if(!STATE.employees.length){
    body.innerHTML=`<div class="card"><div class="empty">${ART.att}<b>まだデータがありません</b><br>従業員を登録して勤怠をつけると<br>ここに売上ダッシュボードが表示されます</div>
      <button class="btn btn-navy" onclick="switchTab('att')">勤怠をつけはじめる</button></div>`;
    return;
  }
  const now=new Date();const Y=now.getFullYear(),M=now.getMonth()+1;
  const totals=monthTotalsMap();
  dashMonths=[];
  for(let back=11;back>=0;back--){
    const d=new Date(Y,M-1-back,1);
    const y=d.getFullYear(),m=d.getMonth()+1;
    const k=`${y}-${pad2(m)}`;
    dashMonths.push({key:k,y,m,total:totals.get(k)||0});
  }
  const cur=dashMonths[11].total;
  const prev=dashMonths[10].total;
  // 月間目標。未設定なら直近3ヶ月（データのある月）の平均を目安として使う
  let goal=Number(STATE.settings.monthlyGoal)||0;
  let goalAuto=false;
  if(goal<=0){
    const past=dashMonths.slice(8,11).map(m=>m.total).filter(v=>v>0);
    if(past.length){goal=Math.round(past.reduce((a,b)=>a+b,0)/past.length);goalAuto=true;}
  }
  let badge;
  if(prev>0&&cur>0){
    const pct=Math.round((cur-prev)/prev*100);
    badge=pct>0?`<span class="dh-badge up">▲ +${pct}%</span>`
      :pct<0?`<span class="dh-badge down">▼ ${pct}%</span>`
      :`<span class="dh-badge flat">± 0%</span>`;
  }else{
    badge=`<span class="dh-badge flat">先月比 —</span>`;
  }
  // 今月の統計＋累計
  const km=`${Y}-${pad2(M)}`;
  let att=0,otH=0,cum=0;const days=new Set();
  const {empById}=idx();
  canonicalRecords().forEach(r=>{
    if(!recHasData(r))return;
    const emp=empById.get(r.employeeId);
    if(!emp)return;
    cum+=dailyTotal(r,emp).total;
    if(monthKey(r.date)!==km)return;
    att+=(r.attendance||0)+(r.nightAttendance||0);
    otH+=(r.overtimeHours||0)+(r.nightOvertimeHours||0);
    days.add(r.date);
  });
  const avg=days.size?Math.round(cur/days.size):0;
  // タイルのミニ推移用に直近6ヶ月を1回の走査で集計する
  const spark6={att:[],ot:[],avg:[],sales:[]};
  {
    const keys=dashMonths.slice(6).map(m=>m.key);
    const acc={};keys.forEach(k=>acc[k]={att:0,ot:0,sales:0,days:new Set()});
    canonicalRecords().forEach(r=>{
      const k=r.date.slice(0,7);
      if(!acc[k]||!recHasData(r))return;
      const e=empById.get(r.employeeId);if(!e)return;
      acc[k].att+=(r.attendance||0)+(r.nightAttendance||0);
      acc[k].ot+=(r.overtimeHours||0)+(r.nightOvertimeHours||0);
      acc[k].sales+=dailyTotal(r,e).total;
      acc[k].days.add(r.date);
    });
    keys.forEach(k=>{const a=acc[k];
      spark6.att.push(a.att);spark6.ot.push(a.ot);spark6.sales.push(a.sales);
      spark6.avg.push(a.days.size?Math.round(a.sales/a.days.size):0);});
  }
  // 従業員別（今月・暦月）
  const perEmp=STATE.employees
    .map(e=>({name:e.name,total:periodReport(e,`${km}-01`,`${km}-${pad2(new Date(Y,M,0).getDate())}`).grandTotal}))
    .filter(x=>x.total>0).sort((a,b)=>b.total-a.total);
  const maxEmp=perEmp.length?perEmp[0].total:0;

  body.innerHTML=`${chartDefsOnce()}
    <div class="dash-hero">
      <i class="mesh"></i><i class="grain"></i>
      <div class="hero-body">
        <div class="dh-l">今月の売上（${Y}年${M}月・暦月）</div>
        <div class="dh-v" id="dash-v">${yenHTML(0)}</div>
        <div class="dh-row">${badge}<span class="dh-sub">先月 ${yen(prev)}</span></div>
      </div>
    </div>
    <div class="stat-grid">
      <div class="stat"><div class="stat-top"><span class="stat-l">出勤（人工）</span>${STAT_ICONS.att}</div>
        <div class="stat-v">${att}<small>人工</small></div>${sparkline(spark6.att)}</div>
      <div class="stat"><div class="stat-top"><span class="stat-l">残業時間</span>${STAT_ICONS.ot}</div>
        <div class="stat-v">${otH}<small>h</small></div>${sparkline(spark6.ot,true)}</div>
      <div class="stat"><div class="stat-top"><span class="stat-l">稼働日の平均</span>${STAT_ICONS.avg}</div>
        <div class="stat-v">${fmtMan(avg)}<small>円/日</small></div>${sparkline(spark6.avg)}</div>
      <div class="stat"><div class="stat-top"><span class="stat-l">これまでの累計</span>${STAT_ICONS.cum}</div>
        <div class="stat-v">${fmtMan(cum)}<small>円</small></div>${sparkline(spark6.sales)}</div>
    </div>
    <div class="card ring-card">
      <div class="ring-slot" data-chart="ring"></div>
      <div class="ring-info">
        <div class="card-t" style="margin-bottom:6px;">今月の目標</div>
        <div class="ring-goal">${goal>0?yen(goal):'未設定'}${goalAuto?'<span class="ring-auto">直近3ヶ月の平均</span>':''}</div>
        <div class="ring-rest">${goal>cur?`あと ${yen(goal-cur)}`:goal>0?'目標達成':'設定タブで決められます'}</div>
      </div>
    </div>
    <div class="card">
      <div class="card-t">月別売上（直近12ヶ月）</div>
      <div class="chart-wrap ph-bar" data-chart="bar"></div>
    </div>
    <div class="card">
      <div class="card-t">今月の積み上がり</div>
      <div class="chart-wrap ph-area" data-chart="area"></div>
    </div>
    <div class="card">
      <div class="card-t">従業員別（今月）</div>
      ${perEmp.length?perEmp.map(x=>`
        <div class="eb-row"><div class="eb-name">${esc(x.name)}</div>
        <div class="eb-track"><div class="eb-fill" style="width:${maxEmp?Math.round(x.total/maxEmp*100):0}%"></div></div>
        <div class="eb-val">${yen(x.total)}</div></div>`).join('')
      :'<div style="font-size:var(--fs-sm);color:var(--mut);">今月の勤怠データはまだありません</div>'}
    </div>`;
  animateYen($('dash-v'),cur);
  // グラフは切替アニメーションが終わった次のフレームで描く（切替の最長フレームを伸ばさない）
  requestAnimationFrame(()=>{
    const bar=body.querySelector('[data-chart="bar"]');
    if(bar)bar.innerHTML=buildBarChart()+'<div class="chart-tip" id="dash-tip"></div>';
    const area=body.querySelector('[data-chart="area"]');
    if(area)area.innerHTML=buildAreaChart(Y,M,goal);
    const ring=body.querySelector('[data-chart="ring"]');
    if(ring)ring.innerHTML=buildRing(cur,goal);
    dashAnimated=true;
  });
  dashDirty=false;
}

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

let attView='list'; // 'list' | 'cal'
function setAttView(v){logUse('表示切替',v);attView=v;haptic();renderAtt();}
window.setAttView=setAttView;

function blankRec(){return {attendance:0,overtimeHours:0,nightAttendance:0,nightOvertimeHours:0,transportFee:0};}

/* 日次行のクラス（全体描画と差分更新で同じ計算を使う） */
function dayRowClass(ds,rec){
  const d=new Date(ds+'T00:00:00'),dow=d.getDay();
  const hol=jpHoliday(d.getFullYear(),d.getMonth()+1,d.getDate());
  const cls=['day'];
  if((rec.attendance||0)>0||(rec.nightAttendance||0)>0||(rec.nightOvertimeHours||0)>0)cls.push('work');
  if(dow===0||hol)cls.push('weekend');
  if(dow===6&&!hol)cls.push('sat');
  return cls.join(' ');
}
/* 表示中の月の合計 */
function monthRunTotal(emp){
  let t=0;
  const recMap=new Map();
  (idx().byEmp.get(emp.id)||[]).forEach(r=>recMap.set(r.date,r));
  daysInMonthList(viewY,viewM).forEach(ds=>{
    const rec=recMap.get(ds);
    if(rec&&recHasData(rec))t+=dailyTotal(rec,emp).total;
  });
  return t;
}
/* 合計バーだけ更新する */
function updateRunTotal(emp){
  const el=$('run-v');if(!el)return;
  const total=monthRunTotal(emp);
  animateYen(el,total);
  lastRunTotal=total;
  const cheer=document.querySelector('.runbar .rcheer');
  if(cheer)cheer.textContent=total===0?'今月はこれから':total<100000?'コツコツ積み上げ中':total<300000?'今月もお疲れさま':'おっ、いい月だ';
}
/* 1日分だけ差し替える（31日分を作り直さないための差分更新） */
function updateDayRow(ds,emp){
  const row=document.querySelector(`.day[data-d="${ds}"]`);
  if(!row)return false;
  const rec=recordForDay(emp.id,ds)||blankRec();
  row.className=dayRowClass(ds,rec);
  const right=row.querySelector('.dcell-r');
  if(!right)return false;
  right.innerHTML=dayControlsHTML(ds,rec,emp);
  return true;
}
/* 金額表示だけ更新する（入力中のフォーカスを壊さないため行は作り直さない） */
function updateDayTotalOnly(ds,emp){
  const row=document.querySelector(`.day[data-d="${ds}"]`);
  if(!row)return false;
  const rec=recordForDay(emp.id,ds)||blankRec();
  const t=dailyTotal(rec,emp);
  const has=recHasData(rec);
  const el=row.querySelector('.day-total');
  if(!has||!el)return false;               // 表示の有無が変わる場合は行ごと作り直す
  if(t.overridden!==el.classList.contains('ovr'))return false;
  el.innerHTML=(t.overridden?'<span class="ovr-tag">手動</span>':'')+yen(t.total);
  return true;
}

/* 1日分の入力コントロール（リスト行と日別シートで共用） */
function dayControlsHTML(ds,rec,emp){
  const t=dailyTotal(rec,emp);
  const has=recHasData(rec);
  const nightEnabled=(emp.nightWage||0)>0;
  const hasNight=(rec.nightAttendance>0||rec.nightOvertimeHours>0);
  // 入力済みの夜勤データは、夜間単価が未設定でも必ず表示する。
  // 以前は nightEnabled で欄ごと隠していたため、入力した夜勤・夜間残業が
  // 画面から消えたうえ 0円で計算され、請求金額が過少になっていた。
  const showNight=hasNight||(nightEnabled&&nightExpanded.has(xk(ds)));
  const nightNoRate=hasNight&&!nightEnabled;
  // 1日に2人工はありえない。1人工を超えた分は残業として入れる。
  // 以前は 1.5 と 2 を選べたため、日給の2倍が割増なしで計上できてしまった。
  const attOpts=[0.5,1];
  return `
        <div class="shift-label">日勤</div>
        <div class="att-btns">
          <button class="att-b${rec.attendance===0?' sel':''}" onclick="setAtt('${ds}','attendance',0)">休</button>
          ${attOpts.map(v=>`<button class="att-b${rec.attendance===v?' sel':''}" onclick="setAtt('${ds}','attendance',${v})">${v}</button>`).join('')}
        </div>
        <div class="att-sub">
          <div class="att-mini"><label>残業h</label><input type="number" inputmode="decimal" min="0" max="24" step="0.5" value="${rec.overtimeHours||''}" placeholder="0" onchange="setAtt('${ds}','overtimeHours',this.value)"></div>
          <div class="att-mini"><label>車代</label><input type="number" inputmode="numeric" min="0" max="100000" step="1" value="${rec.transportFee||''}" placeholder="0" onchange="setAtt('${ds}','transportFee',this.value)"></div>
        </div>
        ${(rec.transportFee||0)>0?`<button class="tr-give${rec.transportToWorker?' on':''}" onclick="toggleTrGive('${ds}')">${rec.transportToWorker?'✓ 車代を本人に渡した':'車代を本人に渡す'}</button>`:''}
        ${showNight?`
        <div class="night-sec">
          <div class="shift-label night">夜勤</div>
          <div class="att-btns">
            <button class="att-b night${(rec.nightAttendance||0)===0?' sel':''}" onclick="setAtt('${ds}','nightAttendance',0)">休</button>
            ${attOpts.map(v=>`<button class="att-b night${rec.nightAttendance===v?' sel':''}" onclick="setAtt('${ds}','nightAttendance',${v})">${v}</button>`).join('')}
          </div>
          <div class="att-sub">
            <div class="att-mini"><label>夜残業h</label><input type="number" inputmode="decimal" min="0" max="24" step="0.5" value="${rec.nightOvertimeHours||''}" placeholder="0" onchange="setAtt('${ds}','nightOvertimeHours',this.value)"></div>
          </div>
          ${nightNoRate?`<div class="warn-strip">夜間単価が未設定のため <b>0円</b> で計算されています。「編集」から夜間単価を設定してください</div>`:''}
        </div>`:(nightEnabled?`<button class="night-add" onclick="toggleNight('${ds}')">＋ 夜勤を入力</button>`:'')}
        ${t.overridden||manualExpanded.has(xk(ds))?`
        <div class="manual-sec">
          <div class="att-mini"><label>合計を手入力</label><input type="number" inputmode="numeric" min="0" max="10000000" step="1" value="${rec.manualTotal||''}" placeholder="自動計算" onchange="setAtt('${ds}','manualTotal',this.value)"></div>
          ${t.overridden?`<button class="manual-reset" onclick="setAtt('${ds}','manualTotal',0)">自動に戻す</button>`:''}
        </div>`:`<button class="manual-add" onclick="toggleManual('${ds}')">✎ 合計を手入力</button>`}
        ${has?`<div class="day-total${t.overridden?' ovr':''}">${t.overridden?'<span class="ovr-tag">手動</span>':''}${yen(t.total)}</div>`:''}`;
}

/* カレンダーグリッド（金額ヒートマップ＋出勤ドット＋祝日） */
function buildCalendar(days,recMap,emp){
  let max=0;const totals=new Map();
  days.forEach(ds=>{
    const rec=recMap.get(ds);
    if(rec&&recHasData(rec)){const t=dailyTotal(rec,emp).total;totals.set(ds,t);if(t>max)max=t;}
  });
  const todayStr=ymd(new Date().getFullYear(),new Date().getMonth()+1,new Date().getDate());
  const first=new Date(days[0]+'T00:00:00').getDay();
  let cells='';
  for(let i=0;i<first;i++)cells+='<div class="cal-cell blank"></div>';
  days.forEach(ds=>{
    const d=new Date(ds+'T00:00:00');
    const dow=d.getDay();
    const hol=jpHoliday(d.getFullYear(),d.getMonth()+1,d.getDate());
    const rec=recMap.get(ds);
    const t=totals.get(ds)||0;
    const cls=['cal-cell'];
    if(dow===0||hol)cls.push('sun');else if(dow===6)cls.push('sat');
    if(ds===todayStr)cls.push('today');
    const dots=((rec&&rec.attendance>0)?'<i class="dot-day"></i>':'')+((rec&&rec.nightAttendance>0)?'<i class="dot-night"></i>':'');
    // 金額のヒートマップ。濃い側は文字が読めなくなるので .hot で前景を反転する
    const tint=(max&&t)?(10+46*(t/max)):0;
    if(tint>=34)cls.push('hot');
    const aria=`${d.getMonth()+1}月${d.getDate()}日${hol?' '+hol:''}${t?' '+yen(t):' 未入力'}`;
    cells+=`<button type="button" class="${cls.join(' ')}"${tint?` style="--cell-tint:${tint.toFixed(0)}%"`:''} aria-label="${esc(aria)}" onclick="openDaySheet('${ds}')">
      <span class="cal-d">${d.getDate()}</span>
      ${dots?`<span class="cal-dots">${dots}</span>`:''}
      ${hol?`<span class="cal-hol">${esc(hol)}</span>`:''}
    </button>`;
  });
  return `<div class="card">
    <div class="cal-week">${WEEK.map((w,i)=>`<span class="${i===0?'sun':i===6?'sat':''}">${w}</span>`).join('')}</div>
    <div class="cal-grid">${cells}</div>
    <div class="cal-leg"><span><i class="dot-day"></i>日勤</span><span><i class="dot-night"></i>夜勤</span><span><span class="cal-leg-hm"></span>濃いほど金額大</span></div>
  </div>`;
}

function renderAtt(){
  updateHeaderMonth();
  const body=$('att-body');
  const emp=STATE.employees.find(e=>e.id===selEmp);
  if(!emp){
    body.innerHTML=`<div class="empty">${ART.att}<b>まだ従業員がいません</b><br>上の「＋ 追加」から登録してください</div>`;
    return;
  }
  const days=daysInMonthList(viewY,viewM);
  const recMap=new Map();
  (idx().byEmp.get(emp.id)||[]).forEach(r=>recMap.set(r.date,r));
  const otRate=overtimeRate(emp.dailyWage);
  const otRateN=overtimeRate(emp.nightWage||0);
  const nightEnabled=(emp.nightWage||0)>0;

  let runTotal=0;
  days.forEach(ds=>{
    const rec=recMap.get(ds);
    if(rec&&recHasData(rec))runTotal+=dailyTotal(rec,emp).total;
  });

  let html=`<div class="card" style="padding:13px 14px;">
    <div class="att-head">
      <div><div class="att-emp">${esc(emp.name)}</div>
      <div class="att-meta">日給 ${yen(emp.dailyWage)}　残業 ${yen(Math.round(otRate))}/h${nightEnabled?`<br>夜間 ${yen(emp.nightWage)}　夜残業 ${yen(Math.round(otRateN))}/h`:''}</div></div>
      <button class="btn btn-ghost btn-sm" style="width:auto;" onclick="openEmpModal('${emp.id}')">編集</button>
    </div>
    <div class="bulk-row">
      <button class="bulk-b" onclick="bulkFill('weekday')">平日を1で埋める</button>
      <button class="bulk-b danger" onclick="bulkFill('clear')">この月をクリア</button>
    </div></div>`;

  html+=`<div class="seg">
    <button class="seg-b${attView==='list'?' sel':''}" onclick="setAttView('list')">リスト</button>
    <button class="seg-b${attView==='cal'?' sel':''}" onclick="setAttView('cal')">カレンダー</button>
  </div>`;

  if(attView==='cal'){
    html+=buildCalendar(days,recMap,emp);
  }else{
    html+='<div class="day-list">';
    days.forEach(ds=>{
      const d=new Date(ds+'T00:00:00');const dow=d.getDay();
      const hol=jpHoliday(d.getFullYear(),d.getMonth()+1,d.getDate());
      const rec=recMap.get(ds)||blankRec();
      html+=`<div class="${dayRowClass(ds,rec)}" data-d="${ds}">
      <div class="dcell-l"><div class="dnum">${d.getDate()}</div><div class="ddow">${WEEK[dow]}</div>${hol?`<div class="dhol">${esc(hol)}</div>`:''}</div>
      <div class="dcell-r">${dayControlsHTML(ds,rec,emp)}</div>
    </div>`;
    });
    html+='</div>';
  }

  const cheer=runTotal===0?'今月はこれから':runTotal<100000?'コツコツ積み上げ中':runTotal<300000?'今月もお疲れさま':'おっ、いい月だ';
  // 締め日が月末以外だと暦月と請求期間がズレる。数字の食い違いに見えるので明示する
  const bp=billingPeriod(viewY,viewM,STATE.settings.closingDay);
  const sameAsMonth=bp.start===ymd(viewY,viewM,1)&&bp.end===ymd(viewY,viewM,new Date(viewY,viewM,0).getDate());
  const fmtMd=d=>`${+d.slice(5,7)}/${+d.slice(8,10)}`;
  const note=sameAsMonth?'':`<div class="run-note">請求対象は ${fmtMd(bp.start)}〜${fmtMd(bp.end)}</div>`;
  const seed=(lastRunTotal==null)?0:lastRunTotal;
  html+=`<div class="runbar"><i class="mesh"></i><i class="grain"></i>
    <div class="hero-body" style="display:flex;align-items:center;justify-content:space-between;width:100%;">
    <div><div class="rl">${viewY}年${viewM}月 合計（暦月 1日〜末日）</div><div class="rcheer">${cheer}</div>${note}</div>
    <span class="rv" id="run-v">${yenHTML(seed)}</span></div></div>`;
  body.innerHTML=html;
  animateYen($('run-v'),runTotal);
  lastRunTotal=runTotal;
}

/* ---------- 日別シート（カレンダーのセルタップ） ---------- */
let daySheetDate=null;
function openDaySheet(ds){
  logUse('日別シート');
  if(!selEmp)return;
  daySheetDate=ds;
  renderDaySheet();
  $('day-modal').classList.add('show');
  haptic();
}
window.openDaySheet=openDaySheet;
function closeDaySheet(){daySheetDate=null;$('day-modal').classList.remove('show');}
$('day-modal-close').addEventListener('click',closeDaySheet);
$('day-modal').addEventListener('click',e=>{if(e.target===$('day-modal'))closeDaySheet();});
function renderDaySheet(){
  if(!daySheetDate)return;
  const emp=STATE.employees.find(e=>e.id===selEmp);
  if(!emp){closeDaySheet();return;}
  const ds=daySheetDate;
  const d=new Date(ds+'T00:00:00');
  const hol=jpHoliday(d.getFullYear(),d.getMonth()+1,d.getDate());
  const rec=recordForDay(emp.id,ds)||blankRec();
  $('day-modal-title').innerHTML=`${d.getMonth()+1}月${d.getDate()}日（${WEEK[d.getDay()]}）`+
    (hol?`<span style="color:var(--danger);font-size:.72em;font-weight:700;">　${esc(hol)}</span>`:'')+
    `<span style="color:var(--sub);font-size:.72em;font-weight:700;">　${esc(emp.name)}</span>`;
  $('day-sheet-body').innerHTML=`<div class="dcell-r">${dayControlsHTML(ds,rec,emp)}</div>`;
}

function setAtt(date,field,value){
  if(!selEmp)return;
  let v=parseFloat(value);
  if(!Number.isFinite(v)||v<0)v=0;      // 文字列・Infinity・負の値を弾く
  const max=INPUT_MAX[field];
  if(max!=null&&v>max){v=max;toast(`⚠️ ${INPUT_LABEL[field]||'値'}は ${max.toLocaleString('ja-JP')} までです`);}
  let rec=recordForDay(selEmp,date);
  if(!rec){rec={id:uid(),employeeId:selEmp,date,attendance:0,overtimeHours:0,nightAttendance:0,nightOvertimeHours:0,transportFee:0};STATE.records.push(rec);}
  const applyDefaultTransport=shouldApplyDefaultTransport(rec,field,v);
  rec[field]=v;
  if(applyDefaultTransport){
    const def=safeNum(STATE.settings.defaultTransportFee,INPUT_MAX.transportFee);
    if(def>0)rec.transportFee=def;
  }
  // 「休」にしたら、その区分の残業も一緒に消す（残ったまま課金されるのを防ぐ）
  if(field==='attendance'&&v===0)rec.overtimeHours=0;
  if(field==='nightAttendance'&&v===0)rec.nightOvertimeHours=0;
  // 日勤も夜勤も休なら車代も外す（出勤していない日に車代はつかない）。
  // 車代だけの日が必要なときは、車代の欄に直接入れれば残る。
  if((field==='attendance'||field==='nightAttendance')&&
     (rec.attendance||0)===0&&(rec.nightAttendance||0)===0){
    rec.transportFee=0;
    // 手入力の合計も一緒に消す。ここを消していなかったため、
    // 「出勤1 → 合計を手入力 → やっぱり休み」の順で押すと
    // 出勤していない日が手入力の額のまま請求されていた。
    if(safeNum(rec.manualTotal,INPUT_MAX.manualTotal)>0){
      rec.manualTotal=0;
      manualExpanded.delete(xk(date));
      toast('休みにしたので、手入力した合計も外しました');
    }
  }
  if(field==='manualTotal'&&v===0)manualExpanded.delete(xk(date));
  // 出勤の入っていない日に金額を入れたら、その場で知らせる。
  // 入力欄は出勤の有無に関係なく出ているので、隣の行に打ち間違えても気づけなかった。
  if((field==='transportFee'||field==='manualTotal')&&v>0&&
     safeNum(rec.attendance,INPUT_MAX.attendance)===0&&
     safeNum(rec.nightAttendance,INPUT_MAX.nightAttendance)===0){
    toast('⚠️ この日は出勤が入っていません。日付を確かめてください');
  }
  // どの欄を何度も打ち直しているかを見る（入れた数字そのものは記録しない）
  noteEdit(date,INPUT_LABEL[field]||field);
  if(v>0){
    if(field==='manualTotal'){noteUsed('合計の手入力欄');logUse('手入力で合計を上書き');}
    if(field==='nightAttendance'||field==='nightOvertimeHours')noteUsed('夜勤欄');
  }
  saveRecords();
  haptic();
  refreshDay(date,field);
  if(daySheetDate)renderDaySheet();
}
window.setAtt=setAtt;

/* 1日分の変更を画面に反映する。31日分を作り直さず、その行だけ差し替える。
   数値入力（残業h・車代）は入力中のフォーカスを壊さないよう金額表示だけ更新する。 */
const REBUILD_FIELDS=['attendance','nightAttendance','manualTotal'];
function refreshDay(ds,field){
  const emp=STATE.employees.find(e=>e.id===selEmp);
  if(!emp)return;
  if(attView!=='list'){renderAtt();return;}   // カレンダー表示は全体を描き直す
  const light=field&&!REBUILD_FIELDS.includes(field);
  const ok=light?(updateDayTotalOnly(ds,emp)||updateDayRow(ds,emp)):updateDayRow(ds,emp);
  if(!ok){renderAtt();return;}                // 行が見つからない等は従来どおり全体描画
  updateRunTotal(emp);
}
function toggleNight(ds){
  const k=xk(ds);
  if(nightExpanded.has(k)){nightExpanded.delete(k);noteClosed('夜勤欄');}
  else{nightExpanded.add(k);noteOpen('夜勤欄');logUse('夜勤欄を開く');}
  haptic();
  refreshDay(ds,'attendance');
  if(daySheetDate)renderDaySheet();
}
window.toggleNight=toggleNight;
/* 車代を本人に渡したかどうか。基本は渡さないので、渡した日だけ印を付ける */
function toggleTrGive(ds){
  logUse('車代を渡す');
  if(!selEmp)return;
  const rec=recordForDay(selEmp,ds);
  if(!rec)return;
  rec.transportToWorker=!rec.transportToWorker;
  saveRecords();haptic();
  refreshDay(ds,'attendance');
  if(daySheetDate)renderDaySheet();
}
window.toggleTrGive=toggleTrGive;
function toggleManual(ds){
  const k=xk(ds);
  if(manualExpanded.has(k)){manualExpanded.delete(k);noteClosed('合計の手入力欄');}
  else{manualExpanded.add(k);noteOpen('合計の手入力欄');logUse('手入力欄を開く');}
  haptic();
  refreshDay(ds,'attendance');
  if(daySheetDate)renderDaySheet();
}
window.toggleManual=toggleManual;

/* 一括入力：平日を1で埋める／この月をクリア */
function bulkFill(mode){
  logUse('一括入力',mode);
  if(!selEmp)return;
  const days=daysInMonthList(viewY,viewM);
  if(mode==='clear'){
    if(!confirm(`${viewY}年${viewM}月の入力をすべてクリアしますか？`))return;
    STATE.records=STATE.records.filter(r=>!(r.employeeId===selEmp&&days.includes(r.date)));
    saveRecords();haptic();renderAtt();toast('この月をクリアしました');
    return;
  }
  if(mode==='weekday'){
    let n=0,nHol=0;
    days.forEach(ds=>{
      const d=new Date(ds+'T00:00:00');const dow=d.getDay();
      if(dow===0||dow===6)return;
      let rec=recordForDay(selEmp,ds);
      if(!rec){rec={id:uid(),employeeId:selEmp,date:ds,attendance:0,overtimeHours:0,nightAttendance:0,nightOvertimeHours:0,transportFee:0};STATE.records.push(rec);}
      if((rec.attendance||0)===0){
        rec.attendance=1;n++;
        if(jpHoliday(d.getFullYear(),d.getMonth()+1,d.getDate()))nHol++;
      }
    });
    saveRecords();haptic();renderAtt();
    toast(`平日${n}日を出勤1にしました${nHol?`（祝日${nHol}日を含む）`:''}`);
  }
}
window.bulkFill=bulkFill;

/* 隠し機能：バージョンを5回タップ → これまでの総支給額 */
(function(){
  const host=$('ver')&&$('ver').parentElement;
  if(!host)return;
  let taps=0,timer=null;
  host.addEventListener('click',()=>{
    taps++;clearTimeout(timer);timer=setTimeout(()=>{taps=0;},1600);
    if(taps>=5){
      taps=0;
      let total=0;
      const {empById}=idx();
      canonicalRecords().forEach(r=>{
        const emp=empById.get(r.employeeId);
        if(emp)total+=dailyTotal(r,emp).total;
      });
      haptic();
      toast(`🏆 これまでの総支給額 ${yen(total)}`);
    }
  });
})();

/* ---------- 従業員モーダル ---------- */
function openEmpModal(id){
  editEmpId=id;
  const emp=id?STATE.employees.find(e=>e.id===id):null;
  $('emp-modal-title').textContent=emp?'従業員を編集':'従業員を追加';
  $('emp-name').value=emp?emp.name:'';
  $('emp-pay').value=(emp&&emp.payWage)?emp.payWage:'';
  $('emp-npay').value=(emp&&emp.payNightWage)?emp.payNightWage:'';
  $('emp-wage').value=emp?emp.dailyWage:'';
  $('emp-nwage').value=(emp&&emp.nightWage)?emp.nightWage:'';
  $('emp-delete').style.display=emp?'flex':'none';
  updateEmpHint();
  noteOpen(id?'従業員の編集':'従業員の追加');
  logUse('従業員',id?'編集を開く':'追加を開く');
  $('emp-modal').classList.add('show');
}
window.openEmpModal=openEmpModal;
function closeEmpModal(){
  noteClosed(editEmpId?'従業員の編集':'従業員の追加');
  $('emp-modal').classList.remove('show');editEmpId=null;
}
$('emp-modal-close').addEventListener('click',closeEmpModal);
$('emp-modal').addEventListener('click',e=>{if(e.target===$('emp-modal'))closeEmpModal();});
$('emp-wage').addEventListener('input',updateEmpHint);
$('emp-nwage').addEventListener('input',updateEmpHint);
function updateEmpHint(){
  const w=parseInt($('emp-wage').value,10)||0;
  const nw=parseInt($('emp-nwage').value,10)||0;
  let lines=[];
  const H=workHours();
  if(w>0) lines.push(`日勤残業 = ${yen(w)} ÷ ${H} × 1.25 = ${yen(Math.round(overtimeRate(w)))}/h`);
  if(nw>0) lines.push(`夜勤残業 = ${yen(nw)} ÷ ${H} × 1.25 = ${yen(Math.round(overtimeRate(nw)))}/h`);
  $('emp-ot-hint').innerHTML=lines.join('<br>');
}
$('emp-save').addEventListener('click',()=>{
  noteUsed(editEmpId?'従業員の編集':'従業員の追加');
  const name=$('emp-name').value.trim();
  const wage=parseInt($('emp-wage').value,10);
  const nwageRaw=$('emp-nwage').value.trim();
  const nwage=nwageRaw===''?0:(parseInt(nwageRaw,10)||0);
  if(!name){toast('⚠️ 名前を入力してください');return;}
  if(!Number.isFinite(wage)||wage<=0){toast('⚠️ 日給を正しく入力してください');return;}
  if(wage>WAGE_MAX){toast(`⚠️ 日給は ${WAGE_MAX.toLocaleString('ja-JP')} 円までです。桁を確認してください`);return;}
  if(nwage>WAGE_MAX){toast(`⚠️ 夜間単価は ${WAGE_MAX.toLocaleString('ja-JP')} 円までです。桁を確認してください`);return;}
  const payRaw=$('emp-pay').value.trim(),npayRaw=$('emp-npay').value.trim();
  const pay=payRaw===''?0:(parseInt(payRaw,10)||0);
  const npay=npayRaw===''?0:(parseInt(npayRaw,10)||0);
  if(pay>WAGE_MAX||npay>WAGE_MAX){toast(`⚠️ 支払単価は ${WAGE_MAX.toLocaleString('ja-JP')} 円までです`);return;}
  // 桁の打ち間違いを止める。上限100万円だけでは 18,000 を 180,000 と打っても素通りだった
  if(!wageLooksSane('日給',wage))return;
  if(nwage>0&&!wageLooksSane('夜間単価',nwage))return;
  if(pay>0&&!wageLooksSane('支払の日給',pay))return;
  if(editEmpId){
    const e=STATE.employees.find(x=>x.id===editEmpId);
    if(e){
      // 古いデータは payWage が未設定（undefined）で、空欄は 0 になる。
      // そのまま比べると「触っていないのに変更あり」と判定され、
      // 確認ダイアログが出て余計な単価履歴まで作られていた。
      const n0=v=>Number(v)||0;
      const changed=(n0(e.dailyWage)!==n0(wage)||n0(e.nightWage)!==n0(nwage)||
                     n0(e.payWage)!==n0(pay)||n0(e.payNightWage)!==n0(npay));
      const hasData=(idx().byEmp.get(e.id)||[]).some(recHasData);
      if(changed&&hasData){
        // 単価を変えると過去の月の金額まで書き換わってしまうため、適用開始日を選ばせる
        const per=billingPeriod(billY,billM,STATE.settings.closingDay);
        const md=d=>`${+d.slice(5,7)}月${+d.slice(8,10)}日`;
        const applyAll=confirm(
          `${e.name} の単価を変更します。\n\n`+
          `【OK】過去の勤怠にも新しい単価を適用する\n`+
          `　　　入力ミスの訂正はこちら。過去の請求額も変わります。\n\n`+
          `【キャンセル】${md(per.start)}以降の勤怠から新しい単価にする\n`+
          `　　　値上げはこちら。過去の金額は変わりません。`);
        if(!applyAll){
          // これまでの単価を「その日まで」の履歴として残し、新単価を期首から適用する
          if(!Array.isArray(e.wageHistory)||!e.wageHistory.length){
            e.wageHistory=[{from:'0000-01-01',dailyWage:e.dailyWage,nightWage:e.nightWage,
              payWage:e.payWage||0,payNightWage:e.payNightWage||0}];
          }
          // その日以降を新しい単価にするので、それより後の履歴は消す。
          // 残すと「設定画面に出ている単価」と「実際に計算に使う単価」がずれ、
          // 画面は19,000なのに請求書は20,000、という食い違いが起きていた。
          e.wageHistory=replaceWageHistoryFrom(e.wageHistory,per.start,
            {dailyWage:wage,nightWage:nwage,payWage:pay,payNightWage:npay});
          toast(`${md(per.start)}以降の単価を変更しました`);
        }else{
          e.wageHistory=null;   // 全期間を新しい単価で計算する
        }
      }
      e.name=name;e.dailyWage=wage;e.nightWage=nwage;e.payWage=pay;e.payNightWage=npay;
    }
  }else{
    const e={id:uid(),name,dailyWage:wage,nightWage:nwage,payWage:pay,payNightWage:npay,createdAt:new Date().toISOString()};
    STATE.employees.push(e);selEmp=e.id;
  }
  saveEmployees();closeEmpModal();renderEmpRow();renderAtt();
  haptic();toast('✓ 保存しました');
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

  // 夜勤データがあるのに夜間単価が未設定の従業員（0円で計算され請求が過少になる）
  const nightNoRate=STATE.employees.filter(e=>{
    if((e.nightWage||0)>0)return false;
    return (idx().byEmp.get(e.id)||[]).some(r=>
      r.date>=period.start&&r.date<=period.end&&
      ((r.nightAttendance||0)>0||(r.nightOvertimeHours||0)>0));
  });

  let subtotal=0; reports.forEach(x=>subtotal+=x.rep.grandTotal);
  const tax=calcTax(subtotal,s.taxRate);
  const total=subtotal+tax;
  // 本人への支払と、親方の取り分（粗利）
  const pays=reports.map(({emp})=>({emp,pay:payReport(emp,period.start,period.end)}));
  let payTotalAll=0; pays.forEach(x=>payTotalAll+=x.pay.grandTotal);
  const margin=subtotal-payTotalAll;   // 税抜の請求額から支払額を引く
  if(reports.length){
    $('grand-v').innerHTML=yenHTML(lastGrandTotal==null?0:lastGrandTotal);
    animateYen($('grand-v'),total);
    lastGrandTotal=total;
  }else{
    $('grand-v').textContent='¥ —';
    lastGrandTotal=null;
  }
  $('grand-sub').textContent=reports.length?`税抜 ${yen(subtotal)} ＋ 消費税 ${yen(tax)}（${reports.length}名）`:'この期間のデータがありません';

  const list=$('sum-list');list.innerHTML='';
  if(nightNoRate.length){
    const w=document.createElement('div');w.className='warn-card';
    w.innerHTML=`<b>夜間単価が未設定です</b><br>${nightNoRate.map(e=>esc(e.name)).join('・')} は
      この期間に夜勤の入力がありますが、夜間単価が未設定のため <b>0円</b> で計算されています。
      このまま発行すると請求額が実際より少なくなります。設定タブの従業員編集から夜間単価を入れてください。`;
    list.appendChild(w);
  }
  if(!reports.length){
    list.insertAdjacentHTML('beforeend',`<div class="empty">${ART.bill}<b>この期間のデータがありません</b><br>「勤怠」タブで出勤を入力してください</div>`);
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
      ${(()=>{const pr=payReport(emp,period.start,period.end);
        const diff=rep.grandTotal-pr.grandTotal;
        return `<div class="pay-row">
          <span class="pay-l">本人へ支払</span><span class="pay-v">${yen(pr.grandTotal)}</span>
          ${diff!==0?`<span class="pay-m">取り分 ${yen(diff)}</span>`:''}
        </div>`;})()}
      <div class="emp-btns">
        <button class="btn btn-navy btn-sm" onclick="makeInvoice('${emp.id}')">${ICON_DOC}請求書</button>
        <button class="btn btn-ghost btn-sm" onclick="makePaySlip('${emp.id}')">支払明細</button>
      </div>`;
    list.appendChild(div);
  });
  // 取り分（粗利）のまとめ
  if(margin<0){
    const w=document.createElement('div');w.className='warn-card';
    w.innerHTML=`<b>支払のほうが請求より多くなっています</b><br>
      この期間は ${yen(-margin)} の持ち出しです。支払単価が請求単価を上回っていないか確認してください。`;
    list.appendChild(w);
  }
  if(payTotalAll>0){
    const m=document.createElement('div');m.className='margin-card'+(margin<0?' minus':'');
    m.innerHTML=`<div class="margin-row"><span>元請けへの請求（税抜）</span><b>${yen(subtotal)}</b></div>
      <div class="margin-row"><span>従業員への支払</span><b>−${yen(payTotalAll)}</b></div>
      <div class="margin-row total"><span>手元に残る（税抜）</span><b>${yen(margin)}</b></div>`;
    list.appendChild(m);
  }
}

/* ===== PDF ===== */
/* ---------- 従業員への支払明細 ----------
   月末の手計算をなくすのが目的。出面から自動で1人分の明細を作る。 */
function buildPaySlipHTML(emp,rep,period,cssMode){
  const s=STATE.settings;
  const css=(cssMode==='screen')?SCREEN_CSS:PRINT_CSS;
  // 明細の各行はその日の単価で計算している。ヘッダだけ最新単価を出していたため、
  // 期の途中で単価を変えるとヘッダと中身が食い違っていた。期末時点の単価に合わせる。
  const rates=payRates(emp,period.end);
  const startRates=payRates(emp,period.start);
  // 期中に A→B→A と戻したケースも「変更あり」として表示する。
  const changedInside=Array.isArray(emp.wageHistory)&&emp.wageHistory.some(w=>w.from>period.start&&w.from<=period.end);
  const rateChanged=changedInside||startRates.dailyWage!==rates.dailyWage||startRates.nightWage!==rates.nightWage;
  const otRate=overtimeRate(rates.dailyWage), otRateN=overtimeRate(rates.nightWage);
  const nightOn=rates.nightWage>0&&(rep.totalNightAttendance>0||rep.totalNightOvertimePay>0);
  const rows=daysInPeriod(period.start,period.end).map(ds=>{
    const rec=rep.records.find(r=>r.date===ds);
    if(!rec)return '';
    const t=payTotal(rec,emp);
    if(t.total<=0)return '';
    const d=new Date(ds+'T00:00:00');
    const lbl=`${d.getMonth()+1}/${d.getDate()}(${WEEK[d.getDay()]})`;
    const att=safeNum(rec.attendance,INPUT_MAX.attendance);
    const natt=safeNum(rec.nightAttendance,INPUT_MAX.nightAttendance);
    const kubun=[att>0?'日勤':'',natt>0?'夜勤':''].filter(Boolean).join('・')||'—';
    return `<tr><td class="inv-l">${lbl}</td><td class="inv-c">${kubun}</td>
      <td class="inv-c">${att+natt||'—'}</td><td>${yen(t.wage+t.nwage)}</td>
      <td>${yen(t.ot+t.not)}</td><td>${yen(t.tr)}</td>
      <td class="inv-bold">${yen(t.total)}</td></tr>`;
  }).join('');
  const totalDays=rep.totalAttendance+rep.totalNightAttendance;
  return `<style>${css}</style><div class="inv-page">
    <div class="inv-topbar"></div>
    <div class="inv-inner">
      <div class="inv-p1-top">
        <div><div class="inv-p1-title">支　払　明　細</div><div class="inv-title-en">P A Y M E N T</div></div>
        <div class="inv-p1-meta">対象期間：${period.label}<br>発行日：<b>${fmtDateJ(ymd(new Date().getFullYear(),new Date().getMonth()+1,new Date().getDate()))}</b></div>
      </div>
      <div class="inv-parties">
        <div><div class="inv-client-name">${esc(emp.name)}　殿</div></div>
        <div class="inv-p1-issuer"><div class="inv-p1-issuer-name">${esc(s.issuer.companyName||'')}</div>
          <div class="inv-p1-issuer-detail">${esc(s.issuer.address||'')}<br>${s.issuer.phone?'TEL：'+esc(s.issuer.phone):''}</div></div>
      </div>
      <div class="inv-amount-row">
        <span class="inv-total-label">お 支 払 額</span>
        <span><span class="inv-total-amount">${yen(rep.grandTotal)}</span>
        <span class="inv-total-sub">出勤 ${totalDays}日</span></span>
      </div>
      <div class="inv-subject"><span>単価</span>日給 ${yen(rates.dailyWage)}／残業 ${yen(Math.round(otRate))}/h${nightOn?`　夜間 ${yen(rates.nightWage)}／夜残業 ${yen(Math.round(otRateN))}/h`:''}${rateChanged?`（期間中に変更あり／期首 日給 ${yen(startRates.dailyWage)}${startRates.nightWage>0?`・夜間 ${yen(startRates.nightWage)}`:''}）`:''}</div>
      <table class="inv-detail">
        <thead><tr><th class="inv-l">日付</th><th class="inv-c">区分</th><th class="inv-c">出勤</th><th>人工代</th><th>残業代</th><th>車代</th><th>計</th></tr></thead>
        <tbody>${rows}
          <tr class="inv-total-row"><td class="inv-l">合計</td><td></td><td class="inv-c">${totalDays}</td>
            <td>${yen(rep.totalDailyWage+rep.totalNightWage)}</td>
            <td>${yen(rep.totalOvertimePay+rep.totalNightOvertimePay)}</td>
            <td>${yen(rep.totalTransportFee)}</td><td>${yen(rep.grandTotal)}</td></tr>
        </tbody>
      </table>
      <div class="inv-p1-foot"><span>${esc(s.issuer.companyName||'')}</span><span>支払明細</span></div>
    </div>
  </div>`;
}
function makePaySlip(empId){
  logUse('支払明細');
  const emp=STATE.employees.find(e=>e.id===empId);if(!emp)return;
  const period=billingPeriod(billY,billM,STATE.settings.closingDay);
  const rep=payReport(emp,period.start,period.end);
  if(rep.grandTotal<=0){toast('⚠️ この期間の出面がありません');return;}
  showPreview(buildPaySlipHTML(emp,rep,period,'screen'),
              buildPaySlipHTML(emp,rep,period,'print'),
              null,false,`${emp.name}さんの支払明細`);
}
window.makePaySlip=makePaySlip;

/* ---------- 発行履歴 ---------- */
/* 発行時点の内容をスナップショットとして保存する。あとで勤怠を直しても
   発行済み請求書の再表示内容を変えないための監査補助。
   法令上の保存要件への適合を、このアプリ単体で保証するものではない。 */
function buildIssue(reports,period,batch){
  const s=STATE.settings;
  let subtotal=0;reports.forEach(r=>subtotal+=r.rep.grandTotal);
  const tax=calcTax(subtotal,s.taxRate);
  return {
    id:uid(), issuedAt:new Date().toISOString(),
    invoiceNo:invoiceNoOf(reports,batch,period),
    issueDate:fmtDateJ(ymd(new Date().getFullYear(),new Date().getMonth()+1,new Date().getDate())),
    period:{start:period.start,end:period.end,label:period.label,periodLabel:period.periodLabel},
    clientName:s.client.companyName||'（請求先未設定）',
    issuerName:s.issuer.companyName||'',
    subtotal, tax, taxRate:s.taxRate, total:subtotal+tax,
    batch:!!batch, voided:false, voidReason:'',
    snapshot:JSON.parse(JSON.stringify({settings:s,reports}))
  };
}
/* 保存後に日付・金額・取引先で識別しやすいファイル名 */
function issueFileName(o){
  const d=(o.issuedAt||'').slice(0,10).replace(/-/g,'')||'00000000';
  const cli=(o.clientName||'取引先').replace(/[\\/:*?"<>|\s]/g,'').slice(0,24);
  return `${d}_${Math.round(o.total)}_${cli}`;
}

/* 角印風の印影を会社名から組む。発行の瞬間に「ポン」と押される演出に使う。
   （次回の電子印鑑機能でも同じ描画を流用できる形にしてある） */
function buildSeal(name){
  const chars=[...(name||'')].filter(c=>!/\s/.test(c)).slice(0,8);
  if(!chars.length)return '';
  const cols=chars.length<=4?2:Math.ceil(chars.length/3);
  const rows=Math.ceil(chars.length/cols);
  const S=100,pad=13,inner=S-pad*2;
  const cw=inner/cols,ch=inner/rows;
  // 縦書きの印相に倣い、右の列から上→下の順に置く
  const cells=chars.map((c,i)=>{
    const col=Math.floor(i/rows),row=i%rows;
    const x=S-pad-cw*(col+.5), y=pad+ch*(row+.5);
    const size=Math.min(cw,ch)*.92;
    return `<text x="${x.toFixed(1)}" y="${(y+size*.34).toFixed(1)}" text-anchor="middle"
      font-size="${size.toFixed(1)}" font-weight="700" fill="#c0392b"
      font-family="'Hiragino Mincho ProN','Yu Mincho',serif">${esc(c)}</text>`;
  }).join('');
  return `<svg class="seal" viewBox="0 0 ${S} ${S}" aria-label="角印 ${esc(name)}">
    <rect x="3" y="3" width="${S-6}" height="${S-6}" rx="5" fill="rgba(255,255,255,.35)" stroke="#c0392b" stroke-width="5"/>
    <rect x="9.5" y="9.5" width="${S-19}" height="${S-19}" rx="3" fill="none" stroke="#c0392b" stroke-width="1.4"/>
    ${cells}
  </svg>`;
}
/* 発行の瞬間に角印を押す */
function stampSeal(){
  const host=$('pv-scroll');
  const name=(pendingIssue&&pendingIssue.issuerName)||STATE.settings.issuer.companyName;
  if(!host||!name||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const page=host.querySelector('.inv-page');
  if(!page)return;
  const old=host.querySelector('.seal-wrap');
  if(old)old.remove();
  const wrap=document.createElement('div');
  wrap.className='seal-wrap';
  wrap.innerHTML=buildSeal(name);
  page.style.position='relative';
  page.appendChild(wrap);
  haptic();
}

let pendingIssue=null;   // プレビュー中の請求書（保存・印刷を押した時点で履歴に記録）
let pendingLogged=false; // 同じプレビューから二重に記録しないためのフラグ

function makeInvoice(empId){
  logUse('請求書');noteUsed('請求タブ（作らず離脱）');
  const emp=STATE.employees.find(e=>e.id===empId);if(!emp)return;
  const s=STATE.settings;
  const period=billingPeriod(billY,billM,s.closingDay);
  const rep=periodReport(emp,period.start,period.end);
  if(rep.grandTotal<=0){toast('⚠️ データがありません');return;}
  const reports=[{emp,rep}];
  const issue=buildIssue(reports,period,false);
  const opt={settings:s,invoiceNo:issue.invoiceNo,issueDate:issue.issueDate};
  showPreview(
    buildInvoiceHTML(reports,period,false,'screen',opt),
    buildInvoiceHTML(reports,period,false,'print',opt),
    issue
  );
}
window.makeInvoice=makeInvoice;

$('batch-pdf-btn').addEventListener('click',()=>{
  logUse('請求書','まとめて');noteUsed('請求タブ（作らず離脱）');
  const s=STATE.settings;
  const period=billingPeriod(billY,billM,s.closingDay);
  const reports=STATE.employees.map(e=>({emp:e,rep:periodReport(e,period.start,period.end)})).filter(x=>x.rep.grandTotal>0);
  if(!reports.length){toast('⚠️ データがありません');return;}
  const issue=buildIssue(reports,period,true);
  const opt={settings:s,invoiceNo:issue.invoiceNo,issueDate:issue.issueDate};
  showPreview(
    buildInvoiceHTML(reports,period,true,'screen',opt),
    buildInvoiceHTML(reports,period,true,'print',opt),
    issue
  );
});

function showPreview(screenHTML,printHTML,issue,alreadyLogged,title){
  $('pv-title').textContent=title||'請求書プレビュー';
  $('pv-scroll').innerHTML=screenHTML;   // 画面用（幅フィット）
  $('print-root').innerHTML=printHTML;   // 印刷用（A4原寸）
  pendingIssue=issue||null;
  pendingLogged=!!alreadyLogged;
  $('pv-overlay').classList.add('show');
  $('pv-scroll').scrollTop=0;
}
$('pv-close').addEventListener('click',()=>{$('pv-overlay').classList.remove('show');pendingIssue=null;});
$('pv-print').addEventListener('click',async()=>{
  const btn=$('pv-print');
  if(btn&&btn.disabled)return;
  if(btn)btn.disabled=true;
  if(pendingIssue&&!pendingLogged){
    const issue=pendingIssue;
    STATE.invoiceLog.push(issue);
    try{
      // 履歴の保存完了を「発行」の成立条件にする。
      await saveInvoiceLog();
    }catch(e){
      const i=STATE.invoiceLog.lastIndexOf(issue);
      if(i>=0)STATE.invoiceLog.splice(i,1);
      if(btn)btn.disabled=false;
      toast('⚠️ 発行履歴を保存できませんでした。印刷は開始していません');
      return;
    }
    pendingLogged=true;
    renderInvoiceLog();
    stampSeal();
    toast('発行履歴に記録しました');
  }
  // WebKitで保存待ちの間にユーザー操作状態が切れた場合、印刷だけ次のタップに分ける。
  if(pendingIssue&&navigator.userActivation&&!navigator.userActivation.isActive){
    if(btn)btn.disabled=false;
    toast('発行履歴は保存済みです。もう一度「保存・印刷」を押してください');
    return;
  }
  // Safari は文書タイトルをPDFの既定ファイル名に使う。識別しやすい名前に一時的に差し替える
  const prevTitle=document.title;
  if(pendingIssue)document.title=issueFileName(pendingIssue);
  setTimeout(()=>{
    try{window.print();}
    finally{setTimeout(()=>{document.title=prevTitle;if(btn)btn.disabled=false;},1000);}
  },60);
});

/* A4請求書HTML（表紙＋必要枚数の明細 / ネイビー×白・帳票風）
   cssMode: 'print'(A4原寸) または 'screen'(画面幅フィット) */
/* 請求番号は年ごとの通し番号（YYYY-000001）。
   相手側の年次連番を採る。月ごとに振り直すより、元請けの経理で追いやすい。
   年は「請求タブでいま見ている月」ではなく、実際に請求している期間から採る
   （1月に12月分を出すと前年の番号になるべきなので）。 */
function invoiceNoOf(reports,batch,period){
  const y=(period&&period.y)||billY;
  return nextInvoiceNumber(STATE.invoiceLog,y);
}
/* opt で設定・請求番号・発行日を差し替えられる（発行履歴からの再表示に使う） */
function buildInvoiceHTML(reports,period,batch,cssMode,opt){
  const s=(opt&&opt.settings)||STATE.settings;
  const css=(cssMode==='screen')?SCREEN_CSS:PRINT_CSS;
  const issueDate=(opt&&opt.issueDate)||fmtDateJ(ymd(new Date().getFullYear(),new Date().getMonth()+1,new Date().getDate()));
  const invNo=(opt&&opt.invoiceNo)||invoiceNoOf(reports,batch,period);

  let subtotal=0; reports.forEach(r=>subtotal+=r.rep.grandTotal);
  const tax=calcTax(subtotal,s.taxRate);
  const total=subtotal+tax;

  const issuer=s.issuer,client=s.client,bank=s.bank;
  // 画面用の角印アニメーションとは別に、印刷/PDF側へも同じ印影を埋め込む。
  const printSeal=(cssMode==='print'&&issuer.companyName)?`<div class="inv-doc-seal">${buildSeal(issuer.companyName)}</div>`:'';

  // ---- 1ページ目 ----
  const empRows=reports.map(r=>{
    const rp=r.rep;
    const att=rp.totalAttendance+rp.totalNightAttendance;
    const wage=rp.totalDailyWage+rp.totalNightWage;
    const ot=rp.totalOvertimePay+rp.totalNightOvertimePay;
    return `
    <tr><td class="inv-l inv-name-cell">${esc(r.emp.name)}</td>
    <td>${att}日</td>
    <td>${yen(wage)}</td>
    <td>${yen(ot)}</td>
    <td>${yen(rp.totalTransportFee)}</td>
    <td class="inv-bold">${yen(rp.grandTotal)}</td></tr>`;
  }).join('');

  const bankBlock=(bank.bankName||bank.accountNumber)?`
    <div class="inv-bank-box"><div class="inv-bank-title">お振込先</div>
      <div class="inv-bank-row">${esc(bank.bankName)} ${esc(bank.branchName)} ${esc(bank.accountType)} ${esc(bank.accountNumber)}</div>
      <div class="inv-bank-row">名義：${esc(bank.accountHolder)}</div>
    </div>`:'';

  // ---- 出面内訳のシートを先に組み立てる（総ページ数の確定に必要）----
  // A4 1枚に安全に収まる明細行数。これを超える分は自動でページを分けるので、
  // 行が用紙の境目で分断されたりページ番号がずれたりしない
  // 実測でA4 1枚に収まるのは25行。最終シートは「合計」行が1行増えるので23行を上限にする
  const ROWS_PER_SHEET=23;
  const detailSheets=[];
  reports.forEach(({emp,rep})=>{
    const rowList=[];
    daysInPeriod(period.start,period.end).forEach(ds=>{
      const rec=rep.records.find(r=>r.date===ds);
      if(!rec)return;
      const t=dailyTotal(rec,emp);
      const d=new Date(ds+'T00:00:00');
      const dateLbl=`${d.getMonth()+1}/${d.getDate()}(${WEEK[d.getDay()]})`;
      // 手入力で上書きした日は1行にまとめて表示
      if(t.overridden){
        rowList.push(`<tr><td class="inv-l">${dateLbl}</td><td class="inv-c">手動</td><td class="inv-c">—</td><td>${yen(t.total)}</td><td>—</td><td>—</td><td class="inv-bold">${yen(t.total)}</td></tr>`);
        return;
      }
      const hasDay=(rec.attendance||0)>0||(rec.overtimeHours||0)>0;
      const hasNight=(rec.nightAttendance||0)>0||(rec.nightOvertimeHours||0)>0;
      const carOnDay=hasDay; // 車代は当日1回だけ
      if(hasDay){
        const dtl=t.wage+t.ot+(carOnDay?t.tr:0);
        rowList.push(`<tr><td class="inv-l">${dateLbl}</td><td class="inv-c">日勤</td><td class="inv-c">${rec.attendance||0}</td><td>${yen(t.wage)}</td><td>${yen(t.ot)}</td><td>${carOnDay?yen(t.tr):'—'}</td><td class="inv-bold">${yen(dtl)}</td></tr>`);
      }
      if(hasNight){
        const ntl=t.nwage+t.not+(!carOnDay?t.tr:0);
        rowList.push(`<tr><td class="inv-l">${hasDay?'':dateLbl}</td><td class="inv-c"><span class="inv-night-tag">夜勤</span></td><td class="inv-c">${rec.nightAttendance||0}</td><td>${yen(t.nwage)}</td><td>${yen(t.not)}</td><td>${!carOnDay?yen(t.tr):'—'}</td><td class="inv-bold">${yen(ntl)}</td></tr>`);
      }
      if(!hasDay&&!hasNight&&(rec.transportFee||0)>0){
        rowList.push(`<tr><td class="inv-l">${dateLbl}</td><td class="inv-c">—</td><td class="inv-c">0</td><td>¥0</td><td>¥0</td><td>${yen(t.tr)}</td><td class="inv-bold">${yen(t.tr)}</td></tr>`);
      }
    });
    const chunks=[];
    for(let i=0;i<rowList.length;i+=ROWS_PER_SHEET)chunks.push(rowList.slice(i,i+ROWS_PER_SHEET));
    if(!chunks.length)chunks.push([]);
    chunks.forEach((rows,ci)=>{
      detailSheets.push({emp,rep,rows:rows.join(''),
        part:chunks.length>1?`（${ci+1}/${chunks.length}）`:'',
        last:ci===chunks.length-1});
    });
  });

  // 総ページ数＝表紙1 ＋ 明細シート数。ページ番号は固定文字列にしない
  const totalPages=1+detailSheets.length;
  const regNo=String(issuer.invoiceNumber||'').trim();
  const regLabel=/^T\d{13}$/.test(regNo)?`登録番号 ${esc(regNo)} ／ 適格請求書発行事業者`
    :regNo?`登録番号 ${esc(regNo)}（形式を確認してください）`:'インボイス登録番号 未設定';
  const foot=n=>`<div class="inv-p1-foot"><span>${regLabel}</span><span>${n} / ${totalPages}</span></div>`;

  const page1=`<div class="inv-page">
    <div class="inv-topbar"></div>
    <div class="inv-inner">
      <div class="inv-p1-top">
        <div>
          <div class="inv-p1-title">請　求　書</div>
          <div class="inv-title-en">I N V O I C E</div>
        </div>
        <div class="inv-p1-meta">請求番号：<b>${invNo}</b><br>発行日：<b>${issueDate}</b><br>対象期間：${period.label}</div>
      </div>
      <div class="inv-parties">
        <div>
          <div class="inv-client-name">${esc(client.companyName||'（請求先未設定）')}　御中</div>
          <div class="inv-client-detail">
            ${client.postalCode?'〒'+esc(client.postalCode)+'　':''}${esc(client.address||'')}
            ${client.contactName?'<br>ご担当：'+esc(client.contactName)+' 様':''}
          </div>
        </div>
        <div class="inv-p1-issuer">
          <div class="inv-p1-issuer-name">${esc(issuer.companyName||'（自社名未設定）')}</div>
          <div class="inv-p1-issuer-detail">
            ${issuer.postalCode?'〒'+esc(issuer.postalCode)+'<br>':''}
            ${esc(issuer.address||'')}${issuer.address?'<br>':''}
            ${issuer.phone?'TEL：'+esc(issuer.phone)+'<br>':''}
            ${issuer.invoiceNumber?'登録番号：'+esc(issuer.invoiceNumber):''}
          </div>
          ${printSeal}
        </div>
      </div>

      <div class="inv-amount-row">
        <div class="inv-total-label">ご請求金額（税込）</div>
        <div><span class="inv-total-amount">${yen(total)}</span><span class="inv-total-sub">税抜 ${yen(subtotal)} ／ 消費税(${s.taxRate}%) ${yen(tax)}</span></div>
      </div>

      <div class="inv-subject"><span>件名</span>${period.periodLabel}　人工代${batch?`（${reports.length}名分）`:`（${esc(reports[0].emp.name)}）`}</div>

      <table>
        <thead><tr><th class="inv-l">氏名</th><th>出勤</th><th>人工代</th><th>残業</th><th>車代</th><th>小計</th></tr></thead>
        <tbody>
          ${empRows}
        </tbody>
      </table>

      <table class="inv-sum-table">
        <tbody>
          <tr class="inv-sum-line"><td class="inv-l">小計（税抜）</td><td>${yen(subtotal)}</td></tr>
          <tr class="inv-sum-line"><td class="inv-l">消費税（${s.taxRate}%）</td><td>${yen(tax)}</td></tr>
          <tr class="inv-sum-line inv-sum-total"><td class="inv-l">合計（税込）</td><td>${yen(total)}</td></tr>
        </tbody>
      </table>

      ${bankBlock}
      ${foot(1)}
    </div>
  </div>`;

  // ---- 2ページ目以降：出面の内訳 ----
  const detailPages=detailSheets.map((sheet,idx)=>{
    const {emp,rep,rows,part,last}=sheet;
    const otRate=overtimeRate(emp.dailyWage);
    const nightOn=(emp.nightWage||0)>0||rep.totalNightWage>0;
    const otRateN=overtimeRate(emp.nightWage||0);
    const totWage=rep.totalDailyWage+rep.totalNightWage;
    const totOt=rep.totalOvertimePay+rep.totalNightOvertimePay;
    const totAtt=rep.totalAttendance+rep.totalNightAttendance;
    const totalRow=last?`<tr class="inv-total-row"><td class="inv-l">合計</td><td></td><td class="inv-c">${totAtt}</td><td>${yen(totWage)}</td><td>${yen(totOt)}</td><td>${yen(rep.totalTransportFee)}</td><td>${yen(rep.grandTotal)}</td></tr>`:'';
    return `<div class="inv-page">
    <div class="inv-topbar"></div>
    <div class="inv-inner">
      <div class="inv-p2-title">出　面　内　訳</div>
      <div class="inv-p2-sub">${period.label}　／　${esc(s.issuer.companyName||'')}</div>
      <div class="inv-emp-block">
        <div class="inv-emp-block-title">${esc(emp.name)}${part}<span>日給 ${yen(emp.dailyWage)}／残業 ${yen(Math.round(otRate))}/h${nightOn?`　夜間 ${yen(emp.nightWage||0)}／夜残業 ${yen(Math.round(otRateN))}/h`:''}</span></div>
        <table class="inv-detail">
          <thead><tr><th class="inv-l">日付</th><th class="inv-c">区分</th><th class="inv-c">出勤</th><th>人工代</th><th>残業代</th><th>車代</th><th>計</th></tr></thead>
          <tbody>${rows}${totalRow}</tbody>
        </table>
      </div>
      ${foot(idx+2)}
    </div>
  </div>`;
  }).join('');

  return `<style>${css}</style>${page1}${detailPages}`;
}

/* 注意: PRINT_CSS と SCREEN_CSS は同時にDOMへ挿入されるため、
   セレクタは必ず #print-root / #pv-scroll でスコープすること
   （素の .inv-page 同士だと後勝ちで印刷レイアウトが壊れる） */
const PRINT_CSS=`
#print-root{font-family:'Hiragino Mincho ProN','Yu Mincho','Hiragino Kaku Gothic ProN',serif;color:#1c1c1e;background:#fff;}
#print-root *{margin:0;padding:0;box-sizing:border-box;}
#print-root .inv-page{width:210mm;min-height:297mm;background:#fff;page-break-after:always;position:relative;}
#print-root .inv-page:last-child{page-break-after:auto;}
#print-root .inv-topbar{height:5mm;background:linear-gradient(90deg,#1a2744 0%,#2c3e63 100%);}
#print-root .inv-inner{padding:15mm 17mm 24mm;}
#print-root .inv-sans{font-family:'Hiragino Kaku Gothic ProN','Hiragino Sans','Meiryo',sans-serif;}
#print-root .inv-p1-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:11mm;}
#print-root .inv-p1-title{font-size:27pt;letter-spacing:12px;color:#1a2744;font-weight:600;}
#print-root .inv-title-en{font-size:7pt;letter-spacing:5px;color:#9aa0ab;margin-top:1.5mm;font-family:'Hiragino Kaku Gothic ProN',sans-serif;}
#print-root .inv-p1-meta{text-align:right;font-size:8.5pt;color:#555;line-height:1.9;font-family:'Hiragino Kaku Gothic ProN',sans-serif;}
#print-root .inv-p1-meta b{color:#1a2744;}
#print-root .inv-parties{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:9mm;}
#print-root .inv-client-name{font-size:14.5pt;color:#1a2744;border-bottom:1.2pt solid #1a2744;padding-bottom:2.5mm;display:inline-block;min-width:72mm;font-weight:600;}
#print-root .inv-client-detail{font-size:8.5pt;color:#666;margin-top:2.5mm;line-height:1.7;font-family:'Hiragino Kaku Gothic ProN',sans-serif;}
#print-root .inv-p1-issuer{text-align:right;font-family:'Hiragino Kaku Gothic ProN',sans-serif;position:relative;padding-right:24mm;min-height:22mm;}
#print-root .inv-p1-issuer-name{font-size:11.5pt;color:#1a2744;font-weight:700;}
#print-root .inv-p1-issuer-detail{font-size:7.5pt;color:#777;line-height:1.7;margin-top:1.5mm;}
#print-root .inv-doc-seal{position:absolute;right:0;top:-1mm;width:20mm;height:20mm;opacity:.78;mix-blend-mode:multiply;}
#print-root .inv-doc-seal .seal{display:block;width:100%;height:100%;}
#print-root .inv-amount-row{display:flex;align-items:baseline;justify-content:space-between;border-top:1.6pt solid #1a2744;border-bottom:0.5pt solid #d8d8d8;padding:5mm 1mm;margin-bottom:8mm;}
#print-root .inv-total-label{font-size:10.5pt;color:#1a2744;letter-spacing:3px;}
#print-root .inv-total-amount{font-size:26pt;color:#1a2744;font-weight:600;font-family:'Hiragino Sans','Hiragino Kaku Gothic ProN',sans-serif;letter-spacing:0.5px;}
#print-root .inv-total-sub{font-size:7.5pt;color:#999;font-family:'Hiragino Kaku Gothic ProN',sans-serif;margin-left:3mm;}
#print-root .inv-subject{font-size:9.5pt;color:#444;margin-bottom:6mm;font-family:'Hiragino Kaku Gothic ProN',sans-serif;}
#print-root .inv-subject span{color:#999;margin-right:3mm;}
#print-root .inv-page table{width:100%;border-collapse:collapse;margin-bottom:7mm;font-family:'Hiragino Kaku Gothic ProN',sans-serif;}
#print-root .inv-page thead th{font-size:8pt;color:#8890a0;font-weight:600;text-align:right;padding:0 2.5mm 2mm;border-bottom:1.2pt solid #1a2744;letter-spacing:1px;background:none;}
#print-root .inv-page thead th.inv-l{text-align:left;}
#print-root .inv-page thead th.inv-c{text-align:center;}
#print-root .inv-page tbody td{font-size:9pt;color:#333;text-align:right;padding:2.6mm 2.5mm;border-bottom:0.4pt solid #ececec;background:none;}
#print-root .inv-page tbody td.inv-l{text-align:left;}
#print-root .inv-page tbody td.inv-c{text-align:center;}
#print-root .inv-page tr:nth-child(even) td{background:none;}
#print-root .inv-name-cell{color:#1a2744;font-weight:600;}
#print-root .inv-sum-table{max-width:88mm;margin-left:auto;}
#print-root .inv-sum-line td{border:none;padding:1.3mm 2.5mm;font-size:8.5pt;color:#666;}
#print-root .inv-sum-total td{font-size:11.5pt;color:#1a2744;font-weight:700;border-top:1.4pt solid #1a2744;padding-top:2.6mm;border-bottom:none;}
#print-root .inv-bank-box{background:#f7f8fa;border-left:2.2pt solid #1a2744;padding:3.5mm 4.5mm;font-size:8.5pt;color:#444;font-family:'Hiragino Kaku Gothic ProN',sans-serif;line-height:1.8;margin-bottom:7mm;border-radius:0 1mm 1mm 0;}
#print-root .inv-bank-title{font-weight:700;color:#1a2744;letter-spacing:1px;font-size:8.5pt;margin-bottom:1mm;border:none;padding:0;}
#print-root .inv-bank-row{font-size:8.5pt;color:#444;margin-top:0.8mm;}
#print-root .inv-p1-foot{position:absolute;bottom:9mm;left:17mm;right:17mm;display:flex;justify-content:space-between;font-size:7pt;color:#aaa;font-family:'Hiragino Kaku Gothic ProN',sans-serif;border-top:0.4pt solid #eee;padding-top:2mm;}
#print-root .inv-p2-title{font-size:15pt;color:#1a2744;font-weight:600;letter-spacing:4px;margin-bottom:1.5mm;}
#print-root .inv-p2-sub{font-size:8pt;color:#999;font-family:'Hiragino Kaku Gothic ProN',sans-serif;margin-bottom:7mm;padding-bottom:2.5mm;border-bottom:1.2pt solid #1a2744;}
#print-root .inv-emp-block{margin-bottom:8mm;}
#print-root .inv-emp-block-title{font-size:10pt;font-weight:700;color:#1a2744;margin-bottom:2.5mm;font-family:'Hiragino Kaku Gothic ProN',sans-serif;}
#print-root .inv-emp-block-title span{font-size:7.5pt;color:#888;font-weight:normal;margin-left:2mm;}
#print-root .inv-page table.inv-detail thead th{font-size:7.5pt;padding:0 2mm 1.8mm;}
#print-root .inv-page table.inv-detail tbody td{font-size:8pt;padding:1.8mm 2mm;}
#print-root .inv-detail .inv-total-row td{border-top:1.2pt solid #1a2744;border-bottom:none;font-weight:700;color:#1a2744;font-size:8.5pt;background:none!important;padding-top:2.4mm;}
/* 万一シートが用紙をまたいでも、行が途中で分断されずヘッダが継続表示されるように */
#print-root .inv-page tr{break-inside:avoid;page-break-inside:avoid;}
#print-root .inv-page thead{display:table-header-group;}
#print-root .inv-night-tag{display:inline-block;font-size:6.5pt;color:#5b46c9;border:0.5pt solid #b9aef0;border-radius:2mm;padding:0.2mm 1.6mm;margin-left:1mm;vertical-align:middle;}
#print-root .inv-bold{font-weight:700;color:#1a2744;}
@page{size:A4;margin:0;}
`;

/* 画面プレビュー用CSS（A4固定をやめ、画面幅にフィット）。全セレクタを #pv-scroll でスコープ */
const SCREEN_CSS=`
#pv-scroll *{margin:0;padding:0;box-sizing:border-box;}
#pv-scroll{font-family:'Hiragino Mincho ProN','Yu Mincho',serif;color:#1c1c1e;}
/* flex-shrink:0 は必須。#pv-scroll は縦フレックスなので、既定の flex-shrink:1 だと
   ページの高さが圧縮され overflow:hidden で中身が切り取られる（プレビュー途中切れの原因） */
#pv-scroll .inv-page{width:100%;max-width:760px;min-height:auto;flex-shrink:0;background:#fff;border-radius:4px;box-shadow:0 10px 40px rgba(15,20,40,.35),0 2px 8px rgba(15,20,40,.18);overflow:hidden;}
#pv-scroll .inv-topbar{height:6px;background:linear-gradient(90deg,#1a2744 0%,#2c3e63 100%);}
#pv-scroll .inv-inner{padding:26px 22px 30px;}
#pv-scroll .inv-p1-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:26px;gap:10px;}
#pv-scroll .inv-p1-title{font-size:26px;letter-spacing:10px;color:#1a2744;font-weight:600;white-space:nowrap;}
#pv-scroll .inv-title-en{font-size:9px;letter-spacing:4px;color:#9aa0ab;margin-top:4px;font-family:sans-serif;}
#pv-scroll .inv-p1-meta{text-align:right;font-size:10.5px;color:#555;line-height:1.9;font-family:sans-serif;}
#pv-scroll .inv-p1-meta b{color:#1a2744;}
#pv-scroll .inv-parties{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:22px;gap:10px;flex-wrap:wrap;}
#pv-scroll .inv-client-name{font-size:16.5px;color:#1a2744;border-bottom:1.5px solid #1a2744;padding-bottom:7px;display:inline-block;min-width:190px;font-weight:600;}
#pv-scroll .inv-client-detail{font-size:10.5px;color:#666;margin-top:7px;line-height:1.7;font-family:sans-serif;}
#pv-scroll .inv-p1-issuer{text-align:right;font-family:sans-serif;}
#pv-scroll .inv-p1-issuer-name{font-size:13.5px;color:#1a2744;font-weight:700;}
#pv-scroll .inv-p1-issuer-detail{font-size:9.5px;color:#777;line-height:1.7;margin-top:4px;}
#pv-scroll .inv-amount-row{display:flex;align-items:baseline;justify-content:space-between;border-top:2px solid #1a2744;border-bottom:1px solid #d8d8d8;padding:14px 2px;margin-bottom:20px;flex-wrap:wrap;gap:4px;}
#pv-scroll .inv-total-label{font-size:12px;color:#1a2744;letter-spacing:3px;}
#pv-scroll .inv-total-amount{font-size:30px;color:#1a2744;font-weight:600;font-family:'Hiragino Sans',sans-serif;letter-spacing:.5px;}
#pv-scroll .inv-total-sub{font-size:9.5px;color:#999;font-family:sans-serif;margin-left:8px;}
#pv-scroll .inv-subject{font-size:11.5px;color:#444;margin-bottom:16px;font-family:sans-serif;}
#pv-scroll .inv-subject span{color:#999;margin-right:8px;}
#pv-scroll .inv-page table{width:100%;border-collapse:collapse;margin-bottom:18px;font-family:sans-serif;}
#pv-scroll .inv-page thead th{font-size:9.5px;color:#8890a0;font-weight:600;text-align:right;padding:0 7px 6px;border-bottom:1.5px solid #1a2744;letter-spacing:1px;background:none;}
#pv-scroll .inv-page thead th.inv-l{text-align:left;}
#pv-scroll .inv-page thead th.inv-c{text-align:center;}
#pv-scroll .inv-page tbody td{font-size:11px;color:#333;text-align:right;padding:8px 7px;border-bottom:1px solid #ececec;background:none;}
#pv-scroll .inv-page tbody td.inv-l{text-align:left;}
#pv-scroll .inv-page tbody td.inv-c{text-align:center;}
#pv-scroll .inv-page tr:nth-child(even) td{background:none;}
#pv-scroll .inv-name-cell{color:#1a2744;font-weight:600;}
#pv-scroll .inv-sum-table{max-width:320px;margin-left:auto;}
#pv-scroll .inv-sum-line td{border:none;padding:4px 7px;font-size:10.5px;color:#666;}
#pv-scroll .inv-sum-total td{font-size:14px;color:#1a2744;font-weight:700;border-top:1.6px solid #1a2744;padding-top:8px;border-bottom:none;}
#pv-scroll .inv-bank-box{background:#f7f8fa;border-left:3px solid #1a2744;padding:11px 13px;font-size:10.5px;color:#444;font-family:sans-serif;line-height:1.8;margin-bottom:16px;border-radius:0 3px 3px 0;}
#pv-scroll .inv-bank-title{font-weight:700;color:#1a2744;letter-spacing:1px;font-size:10.5px;margin-bottom:3px;border:none;padding:0;}
#pv-scroll .inv-bank-row{font-size:10.5px;color:#444;margin-top:2px;}
#pv-scroll .inv-p1-foot{display:flex;justify-content:space-between;font-size:9px;color:#aaa;font-family:sans-serif;border-top:1px solid #eee;padding-top:8px;margin-top:10px;}
#pv-scroll .inv-p2-title{font-size:17px;color:#1a2744;font-weight:600;letter-spacing:4px;margin-bottom:4px;}
#pv-scroll .inv-p2-sub{font-size:10px;color:#999;font-family:sans-serif;margin-bottom:16px;padding-bottom:7px;border-bottom:1.5px solid #1a2744;}
#pv-scroll .inv-emp-block{margin-bottom:20px;}
#pv-scroll .inv-emp-block-title{font-size:12.5px;font-weight:700;color:#1a2744;margin-bottom:7px;font-family:sans-serif;}
#pv-scroll .inv-emp-block-title span{font-size:9.5px;color:#888;font-weight:normal;margin-left:6px;}
#pv-scroll .inv-page table.inv-detail thead th{font-size:9px;padding:0 5px 5px;}
#pv-scroll .inv-page table.inv-detail tbody td{font-size:9.5px;padding:5.5px 5px;}
#pv-scroll .inv-detail .inv-total-row td{border-top:1.5px solid #1a2744;border-bottom:none;font-weight:700;color:#1a2744;font-size:10.5px;background:none!important;padding-top:7px;}
#pv-scroll .inv-night-tag{display:inline-block;font-size:8px;color:#5b46c9;border:1px solid #b9aef0;border-radius:6px;padding:0 5px;margin-left:4px;vertical-align:middle;}
#pv-scroll .inv-bold{font-weight:700;color:#1a2744;}
`;

/* ===== 設定タブ ===== */
function buildClosingOptions(){
  const sel=$('set-closing');sel.innerHTML='';
  // 29日・30日は月によって存在しないため「月末締め」に寄せる（billingPeriod も29以上を月末扱い）
  for(let d=1;d<=28;d++){const o=document.createElement('option');o.value=d;o.textContent=d+'日締め';sel.appendChild(o);}
  const o=document.createElement('option');o.value=31;o.textContent='月末締め';sel.appendChild(o);
}
/* 選んだ締め日で今月分がどの期間になるかをその場で見せる */
function updateClosingHint(){
  const el=$('closing-hint');if(!el)return;
  const n=new Date(),y=n.getFullYear(),m=n.getMonth()+1;
  const per=billingPeriod(y,m,STATE.settings.closingDay);
  const md=d=>`${+d.slice(5,7)}/${+d.slice(8,10)}`;
  const note=STATE.settings.closingDay>=29?'（29日・30日締めも月末締めを選んでください）':'';
  el.textContent=`${m}月分＝${md(per.start)}〜${md(per.end)}（${daysInPeriod(per.start,per.end).length}日間）${note}`;
}
function loadSettingsForm(){
  const s=STATE.settings;
  $('iss-name').value=s.issuer.companyName;$('iss-zip').value=s.issuer.postalCode;$('iss-tel').value=s.issuer.phone;$('iss-addr').value=s.issuer.address;$('iss-invno').value=s.issuer.invoiceNumber;
  $('cli-name').value=s.client.companyName;$('cli-zip').value=s.client.postalCode;$('cli-contact').value=s.client.contactName;$('cli-addr').value=s.client.address;
  $('bk-bank').value=s.bank.bankName;$('bk-branch').value=s.bank.branchName;$('bk-type').value=s.bank.accountType;$('bk-num').value=s.bank.accountNumber;$('bk-holder').value=s.bank.accountHolder;
  $('set-tax').value=String(s.taxRate);
  // 保存値が選択肢に無い場合（29/30など）は月末締めに寄せて表示のズレを防ぐ
  const cd=String(s.closingDay);
  $('set-closing').value=[...$('set-closing').options].some(o=>o.value===cd)?cd:'31';
  $('set-transport').value=s.defaultTransportFee;$('set-goal').value=s.monthlyGoal||'';
  $('set-workh').value=s.workHours||8;
  updateClosingHint();updateWorkhHint();
}
/* 所定労働時間を変えると残業単価が変わる。何がどう変わるかを画面に出しておく */
function updateWorkhHint(){
  const el=$('workh-hint');if(!el)return;
  const H=workHours();
  const w=(STATE.employees[0]&&STATE.employees[0].dailyWage)||18000;
  el.innerHTML=`残業単価 = 日給 ÷ ${H} × 1.25`+
    `（日給 ${yen(w)} なら ${yen(Math.round(overtimeRate(w)))}/h）`+
    (H===8?'':'<br>※ 発行済みの請求書は変わりませんが、まだ発行していない月の残業代は変わります');
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
    ['set-closing',v=>{STATE.settings.closingDay=parseInt(v,10)||31;updateClosingHint();}],
    ['set-workh',v=>{
      const h=parseFloat(v);
      STATE.settings.workHours=(Number.isFinite(h)&&h>0&&h<=24)?h:8;
      updateWorkhHint();attDirty=true;dashDirty=true;
    }],
    ['set-transport',v=>STATE.settings.defaultTransportFee=parseInt(v,10)||0],
    ['set-goal',v=>STATE.settings.monthlyGoal=parseInt(v,10)||0],
  ];
  m.forEach(([id,fn])=>{
    const el=$(id);const ev=(el.tagName==='SELECT')?'change':'input';
    el.addEventListener(ev,()=>{fn(el.value);saveSettings();});
  });
}
function renderSettingsLists(){
  renderReportPreview();
  renderDataHealth();
  renderInvoiceLog();
  const list=$('set-emp-list');list.innerHTML='';
  if(!STATE.employees.length){list.innerHTML='<div style="font-size:.82rem;color:var(--mut);padding:4px 0;">従業員が登録されていません</div>';return;}
  STATE.employees.forEach(e=>{
    const div=document.createElement('div');div.className='edititem';
    div.innerHTML=`<span class="ei-name">${esc(e.name)}</span><span class="ei-wage">${yen(e.dailyWage)}</span><button onclick="openEmpModal('${e.id}')" aria-label="編集"><svg class="ic" viewBox="0 0 24 24" style="width:17px;height:17px;"><path d="M4 20h4.2L19.5 8.7a2.1 2.1 0 0 0 0-3l-1.2-1.2a2.1 2.1 0 0 0-3 0L4 15.8V20z"/><path d="M13.8 6l4.2 4.2"/></svg></button>`;
    list.appendChild(div);
  });
}
$('set-add-emp').addEventListener('click',()=>openEmpModal(null));

/* ---------- 開発者へのレポート ----------
   目的は「アプリを直すための材料」を集めること。
   氏名・金額・取引先は入れない。数えた回数と、うまくいかなかった形跡だけを送る。 */
function usageSummary(){
  const L=Array.isArray(STATE.usageLog)?STATE.usageLog:[];
  const cnt={},errs=[],warns={},stuck={},days=new Set(),hours=new Array(24).fill(0);
  L.forEach(e=>{
    const d=new Date(e.t);
    days.add(d.toDateString());hours[d.getHours()]++;
    if(e.k==='error'){errs.push(e);return;}
    if(e.k==='警告'){warns[e.v]=(warns[e.v]||0)+1;return;}
    if(e.k==='打ち直し'||e.k==='使わず閉じた'){
      const key=(e.k==='打ち直し'?'何度も打ち直した：':'開いたのに使わなかった：')+e.v;
      stuck[key]=(stuck[key]||0)+1;return;
    }
    const key=e.k+(e.v?'：'+e.v:'');
    cnt[key]=(cnt[key]||0)+1;
  });
  const top=Object.entries(cnt).sort((a,b)=>b[1]-a[1]);
  const first=L.length?new Date(L[0].t):null;
  // よく触っている時間帯。現場で入れているのか帰ってから入れているのかが分かる
  let peak='';
  const maxH=Math.max(...hours);
  if(maxH>0)peak=hours.map((n,h)=>({n,h})).filter(x=>x.n>=maxH*0.6)
    .map(x=>x.h+'時').join('・');
  return {件数:L.length,期間:first?`${first.toLocaleDateString('ja-JP')}〜`:'記録なし',
    よく使う操作:top,エラー:errs,
    警告:Object.entries(warns).sort((a,b)=>b[1]-a[1]),
    詰まり:Object.entries(stuck).sort((a,b)=>b[1]-a[1]),
    使った日数:days.size,よく使う時間:peak};
}
/* 設定の埋まり具合。ここが欠けていると請求書として通らないので、
   使われていないのか、埋め方が分からないのかを切り分ける材料になる。 */
function setupGaps(){
  const s=STATE.settings,g=[];
  if(!s.issuer.companyName)g.push('屋号・氏名');
  if(!s.issuer.invoiceNumber)g.push('インボイス登録番号');
  else if(!/^T\d{13}$/.test(String(s.issuer.invoiceNumber).trim()))g.push('インボイス登録番号の形式');
  if(!s.issuer.address)g.push('住所');
  if(!s.client.companyName)g.push('請求先');
  if(!s.bank.bankName||!s.bank.accountNumber)g.push('振込口座');
  return g;
}
function buildReport(includeData,isAuto){
  const s=usageSummary();
  const dt=new Date();
  const lines=[];
  lines.push(isAuto?'■ 利用レポート（自動送信）':'■ 利用レポート');
  lines.push(`作成日時：${dt.toLocaleString('ja-JP')}`);
  lines.push(`アプリ版：${APP_VERSION}`);
  lines.push(`端末：${navigator.userAgent}`);
  lines.push(`起動方法：${navigator.standalone?'ホーム画面から':'ブラウザから'}`);
  lines.push(`画面：${screen.width}x${screen.height}`);
  lines.push('');
  lines.push('■ 規模');
  lines.push(`従業員：${STATE.employees.length}名 ／ 勤怠：${STATE.records.length}件 ／ 発行履歴：${STATE.invoiceLog.length}件`);
  lines.push(`締め日：${STATE.settings.closingDay===31?'月末':STATE.settings.closingDay+'日'} ／ 税率：${STATE.settings.taxRate}%`);
  const withPay=STATE.employees.filter(e=>(e.payWage||0)>0).length;
  lines.push(`支払単価を設定した従業員：${withPay}名 ／ 単価履歴あり：${STATE.employees.filter(e=>Array.isArray(e.wageHistory)&&e.wageHistory.length).length}名`);
  lines.push('');

  // ここから下が「直すための材料」。数字より、うまくいかなかった形跡を先に出す
  lines.push('■ 詰まっているところ');
  if(!s.詰まり.length&&!s.警告.length)lines.push('  見当たりません');
  s.詰まり.forEach(([k,n])=>lines.push(`  ${n}回  ${k}`));
  s.警告.forEach(([k,n])=>lines.push(`  ${n}回  警告が出た：${k}`));
  lines.push('');

  lines.push('■ 最後までたどり着けているか');
  const hasAtt=STATE.records.some(recHasData);
  const madeInv=STATE.invoiceLog.length>0;
  lines.push(`  勤怠を入れた：${hasAtt?'はい':'いいえ'}`);
  lines.push(`  請求書を作れた：${madeInv?`はい（${STATE.invoiceLog.length}件）`:'いいえ'}`);
  const manualDays=STATE.records.filter(r=>safeNum(r.manualTotal,INPUT_MAX.manualTotal)>0).length;
  if(manualDays)lines.push(`  合計を手入力で上書きした日：${manualDays}日（自動計算が合っていない可能性）`);
  const nightDays=STATE.records.filter(r=>safeNum(r.nightAttendance,INPUT_MAX.nightAttendance)>0).length;
  lines.push(`  夜勤を入れた日：${nightDays}日`);
  const gaps=setupGaps();
  lines.push(gaps.length?`  設定の未入力：${gaps.join('・')}`:'  設定は埋まっています');
  const bad=dataIssues();
  lines.push(bad.length?`  おかしな値の警告：${bad.length}件`:'  データの警告：なし');
  lines.push('');

  lines.push(`■ 使い方（記録 ${s.件数}件 ${s.期間}）`);
  lines.push(`  使った日数：${s.使った日数}日${s.よく使う時間?` ／ よく触る時間帯：${s.よく使う時間}`:''}`);
  s.よく使う操作.slice(0,25).forEach(([k,n])=>lines.push(`  ${n}回  ${k}`));
  if(!s.よく使う操作.length)lines.push('  （記録なし）');
  lines.push('');

  lines.push(`■ エラー（${s.エラー.length}件）`);
  if(!s.エラー.length)lines.push('  なし');
  else s.エラー.slice(-30).forEach(e=>lines.push(`  ${new Date(e.t).toLocaleString('ja-JP')}  ${e.v}`));
  lines.push('');
  const memo=($('rep-memo')&&$('rep-memo').value.trim())||'';
  lines.push('■ 困っていること・要望');
  lines.push(memo?memo:'  （記入なし）');
  lines.push('');
  const out={report:lines.join('\n')};
  if(includeData){
    out.data=JSON.parse(buildBackup());
  }
  return out;
}
function renderReportPreview(){
  const box=$('rep-preview');if(!box)return;
  const inc=$('rep-include')&&$('rep-include').checked;
  const r=buildReport(inc);
  let txt=r.report;
  if(inc){
    const emps=STATE.employees.map(e=>e.name).join('・')||'（なし）';
    txt+='■ 含める実データ\n';
    txt+=`  従業員の氏名：${emps}\n`;
    txt+=`  単価・勤怠・請求先・銀行口座・登録番号を含む全データ（${STATE.records.length}件）\n`;
  }else{
    txt+='■ 実データ\n  含めません（氏名・金額・取引先は一切入りません）\n';
  }
  box.textContent=txt;
}
/* 送信先（サーバー）。設定とは分けて持つ。
   合言葉をバックアップやレポート本文に混ぜないための分離。 */
function saveDest(){return idbSet('reportDest',STATE.reportDest);}
function loadReportDest(){
  const u=$('rep-url'),k=$('rep-key'),a=$('rep-auto'),ad=$('rep-auto-data');
  if(!u||!k)return;
  const d=STATE.reportDest;
  u.value=d.url;k.value=d.key;
  if(a)a.checked=!!d.auto;
  if(ad)ad.checked=!!d.autoData;
  const save=()=>{
    d.url=u.value.trim();d.key=k.value.trim();
    if(a)d.auto=a.checked;
    if(ad)d.autoData=ad.checked;
    d.touched=true;   // 以後は埋め込みの既定値で上書きしない
    saveDest();repStatus('');renderAutoState();
  };
  u.addEventListener('input',save);k.addEventListener('input',save);
  if(a)a.addEventListener('change',()=>{save();if(a.checked)autoReport('設定を入れた直後',true);});
  // 実データを含める設定を変えたら、その場で送り直して結果をすぐ確認できるようにする
  if(ad)ad.addEventListener('change',()=>{save();if(d.auto)autoReport('設定を変えた直後',true);});
  const t=$('rep-test');
  if(t)t.addEventListener('click',testReportDest);
  renderAutoState();
}
// 自動送信が今どうなっているかを画面に出しておく。
// 黙って送るぶん、状態はいつでも見られるようにする。
function renderAutoState(){
  const el=$('rep-auto-state');if(!el)return;
  const d=STATE.reportDest;
  if(!d.auto||!d.url){el.textContent='';return;}
  el.textContent=d.lastAt
    ? `自動送信は入っています（最後に送ったのは ${new Date(d.lastAt).toLocaleString('ja-JP')}）`
    : '自動送信は入っています（まだ一度も送っていません）';
}
function repStatus(msg,cls){
  const el=$('rep-status');if(!el)return;
  el.textContent=msg||'';el.className='rep-status'+(cls?' '+cls:'');
}
// 送信先が使える形かを先に確かめる。http:// のまま貼られると中身が丸見えになる
function destOrNull(){
  const d=STATE.reportDest||{};
  const raw=(d.url||'').trim();
  if(!raw)return null;
  let u;
  try{u=new URL(raw);}catch(e){return {bad:'アドレスの形が正しくありません'};}
  if(u.protocol!=='https:')return {bad:'https:// で始まるアドレスにしてください'};
  return {url:u.href,key:(d.key||'').trim()};
}
async function testReportDest(){
  const d=destOrNull();
  if(!d)return repStatus('送信先が空です','ng');
  if(d.bad)return repStatus('⚠️ '+d.bad,'ng');
  repStatus('確認中…');
  try{
    const res=await postReport(d,{report:'■ 接続テスト\n送信先の確認だけです。',
      version:APP_VERSION,ua:navigator.userAgent,memo:'（接続テスト）'});
    if(res.ok)repStatus('✓ つながりました。テストが1件届いています','ok');
    else repStatus('⚠️ '+res.msg,'ng');
  }catch(e){repStatus('⚠️ '+(e&&e.message||'つながりませんでした'),'ng');}
}
/* ---------- 自動送信 ----------
   「自動で送る」を入れておくと、起動時とアプリを閉じるときに黙って送る。
   使う人の操作を止めない（画面に何も出さない・失敗しても黙って次にまわす）。
   毎回まるごと送ると無駄なので、前回から中身が変わったときだけ送る。 */
const AUTO_INTERVAL=6*3600*1000;   // 最短6時間おき
function deviceId(){
  const d=STATE.reportDest;
  // 端末を見分けるためだけの乱数。氏名や電話番号とは関係がない
  if(!d.device){d.device=uid()+uid();saveDest();}
  return d.device;
}
/* 最後に送った時刻。idbSet は非同期なので、閉じる瞬間の書き込みが間に合わず
   直後の起動でもう一度送ってしまうことがあった。localStorage は同期で書けるので
   こちらを併用して二重送信を防ぐ。 */
function lastSentAt(){
  let ls=0;
  try{ls=Number(localStorage.getItem('autoReportAt'))||0;}catch(e){}
  return Math.max(STATE.reportDest.lastAt||0,ls);
}
function markSent(sig){
  const d=STATE.reportDest;
  d.lastAt=Date.now();d.lastSig=sig;
  try{localStorage.setItem('autoReportAt',String(d.lastAt));}catch(e){}
  return saveDest();
}
function unmarkSent(at,sig){
  const d=STATE.reportDest;
  d.lastAt=at;d.lastSig=sig;
  try{
    if(at)localStorage.setItem('autoReportAt',String(at));
    else localStorage.removeItem('autoReportAt');
  }catch(e){}
  return saveDest();
}
// 中身が変わったかを短い文字列で見る。同じものを何度も送らないため
function dataSignature(){
  const s=STATE.settings;
  // 実データを含めるかどうかも「変化」として数える。
  // これを入れないと、設定を切り替えても次に何か動くまで反映されない。
  return [STATE.reportDest.autoData?'D':'-',
    STATE.employees.length,STATE.records.length,STATE.invoiceLog.length,
    (STATE.usageLog||[]).length,
    STATE.records.reduce((a,r)=>a+(r.attendance||0)+(r.nightAttendance||0)+
      (r.overtimeHours||0)+(r.nightOvertimeHours||0)+(r.transportFee||0)+(r.manualTotal||0),0),
    STATE.employees.reduce((a,e)=>a+(e.dailyWage||0)+(e.nightWage||0)+(e.payWage||0)+(e.payNightWage||0),0),
    s.closingDay,s.taxRate,s.defaultTransportFee,
    (s.client&&s.client.companyName||'').length,
    APP_VERSION].join('|');
}
function startAutoReport(){
  autoReport('起動');
  // ホーム画面に戻る・アプリを閉じるときが最後の機会。iOSはここを逃すと送れない
  const onLeave=()=>{if(document.visibilityState==='hidden')autoReport('離脱',false,true);};
  document.addEventListener('visibilitychange',onLeave);
  window.addEventListener('pagehide',()=>autoReport('離脱',false,true));
}
async function autoReport(why,force,beacon){
  try{
    const d=STATE.reportDest;
    if(!d.auto)return;
    const dest=destOrNull();
    if(!dest||dest.bad)return;
    // 実データを送る設定のときは、閉じる瞬間には送らない。
    // keepalive は 64KB までで、超えるとブラウザが黙って捨ててしまう。
    // まるごと送るのは画面が生きている起動時にまとめてやる。
    if(beacon&&d.autoData)return;
    const sig=dataSignature();
    // 変わっていないなら送らない。変わっていても6時間は空ける
    if(!force){
      if(sig===d.lastSig)return;
      if(Date.now()-lastSentAt()<AUTO_INTERVAL)return;
    }
    if(usageDirty)await saveUsage();
    const withData=!!d.autoData;
    const r=buildReport(withData,true);
    const payload={report:r.report,data:withData?r.data:null,
      version:APP_VERSION,ua:navigator.userAgent,memo:'',
      device:deviceId(),auto:true,why:String(why||'')};
    // 送る前に印を付ける。閉じる瞬間の書き込みは待てないので、
    // 先に印を残しておかないと次の起動で同じものをもう一度送ってしまう。
    const prevAt=d.lastAt,prevSig=d.lastSig;
    markSent(sig);
    const res=await postReport(dest,payload,beacon);
    if(!res.ok){await unmarkSent(prevAt,prevSig);return;}  // 失敗は黙って次の機会にまわす
    renderAutoState();
  }catch(e){/* 自動送信の失敗でアプリを止めない */}
}
async function postReport(dest,payload,keepalive){
  const ctl=(!keepalive&&'AbortController'in window)?new AbortController():null;
  const timer=ctl?setTimeout(()=>ctl.abort(),15000):null;
  try{
    // 合言葉は本文に入れる。HTTPヘッダは英数字しか通せず、
    // 日本語を打たれると fetch 自体が例外になって原因が分からなくなるため。
    const body=JSON.stringify(dest.key?Object.assign({key:dest.key},payload):payload);
    // 画面を閉じる瞬間は keepalive。ページが消えても送信を続けてくれる。
    // 上限 64KB を超えるとブラウザが黙って捨てるので、その場合は諦めて次回にまわす。
    if(keepalive&&new Blob([body]).size>60000)return {ok:false,msg:'大きすぎるため次回に送ります'};
    const res=await fetch(dest.url,{
      method:'POST',mode:'cors',cache:'no-store',keepalive:!!keepalive,
      headers:{'Content-Type':'application/json'},
      body,
      signal:ctl?ctl.signal:undefined
    });
    if(res.ok)return {ok:true};
    if(res.status===401)return {ok:false,msg:'合言葉が違います'};
    if(res.status===413)return {ok:false,msg:'データが大きすぎます'};
    if(res.status===429)return {ok:false,msg:'送りすぎです。少し時間をおいてください'};
    return {ok:false,msg:`送信先が ${res.status} を返しました`};
  }catch(e){
    if(e&&e.name==='AbortError')return {ok:false,msg:'時間内に返事がありませんでした'};
    return {ok:false,msg:'つながりませんでした（電波と送信先を確認してください）'};
  }finally{ if(timer)clearTimeout(timer); }
}
async function sendReport(){
  const inc=$('rep-include')&&$('rep-include').checked;
  if(inc&&!confirm('従業員の氏名・給与額・取引先・銀行口座を含むデータを書き出します。\n\nこの内容を開発者に渡してよいか、従業員の方の了解は取れていますか？\n\nOKで書き出します。'))return;
  const r=buildReport(inc);
  const memo=($('rep-memo')&&$('rep-memo').value.trim())||'';

  // 送信先が入っていれば直接送る。入っていない・失敗したときはファイルに書き出す
  const d=destOrNull();
  if(d&&d.bad){repStatus('⚠️ '+d.bad,'ng');toast('⚠️ '+d.bad);return;}
  if(d){
    const btn=$('rep-send');
    if(btn){btn.disabled=true;btn.textContent='送信中…';}
    repStatus('送信中…');
    const res=await postReport(d,{report:r.report,data:inc?r.data:null,
      version:APP_VERSION,ua:navigator.userAgent,memo});
    if(btn){btn.disabled=false;btn.textContent='この内容を送る';}
    if(res.ok){
      repStatus('✓ 送信しました。ありがとうございます','ok');
      logUse('レポート送信',inc?'実データあり':'記録のみ');saveUsage();
      toast('送信しました');
      if($('rep-memo')){$('rep-memo').value='';renderReportPreview();}
      return;
    }
    repStatus('⚠️ '+res.msg+'。ファイルに書き出します','ng');
  }

  const name=`利用レポート_${ymd(new Date().getFullYear(),new Date().getMonth()+1,new Date().getDate()).replace(/-/g,'')}`;
  const files=[new File([r.report],name+'.txt',{type:'text/plain'})];
  if(inc)files.push(new File([JSON.stringify(r.data,null,2)],name+'_データ.json',{type:'application/json'}));
  // 共有できる端末はLINEやメールへ、できなければ保存する
  try{
    if(navigator.canShare&&navigator.canShare({files})){
      await navigator.share({files,title:'利用レポート'});
      logUse('レポート送信',inc?'実データあり':'記録のみ');saveUsage();
      toast('送信画面を開きました');return;
    }
  }catch(e){ if(e&&e.name==='AbortError')return; }
  files.forEach(f=>{
    const url=URL.createObjectURL(f);const a=document.createElement('a');
    a.href=url;a.download=f.name;document.body.appendChild(a);a.click();document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url),1500);
  });
  logUse('レポート保存',inc?'実データあり':'記録のみ');saveUsage();
  toast('ファイルに保存しました');
}

/* ---------- データの健全性チェック ----------
   入力の上限を付ける前に保存された異常値（桁の打ち間違いなど）を洗い出して知らせる。
   計算側では safeNum で丸めているが、元データが直らないと請求額が合わないため。 */
function dataIssues(){
  const out=[];
  STATE.employees.forEach(e=>{
    if(safeNum(e.dailyWage)>WAGE_MAX)out.push({who:e.name,what:'日給',val:e.dailyWage,max:WAGE_MAX});
    if(safeNum(e.nightWage)>WAGE_MAX)out.push({who:e.name,what:'夜間単価',val:e.nightWage,max:WAGE_MAX});
  });
  const {empById}=idx();
  const cnt={};
  STATE.records.forEach(r=>{
    const emp=empById.get(r.employeeId);
    const nm=emp?emp.name:'（削除済みの従業員）';
    const chk=(k,label,max)=>{
      const v=Number(r[k]);
      if(Number.isFinite(v)&&v>max){const key=nm+'|'+label;cnt[key]=(cnt[key]||0)+1;}
    };
    chk('transportFee','車代',INPUT_MAX.transportFee);
    chk('overtimeHours','残業時間',INPUT_MAX.overtimeHours);
    chk('nightOvertimeHours','夜間残業',INPUT_MAX.nightOvertimeHours);
    chk('manualTotal','手入力の合計',INPUT_MAX.manualTotal);
    // 出勤も夜勤も無い日に金額がついている＝隣の行に打ち間違えた可能性が高い。
    // 現場に出ていないのに車代だけ出る日は実務では無い、という前提で異常として拾う。
    if(emp&&safeNum(r.attendance,INPUT_MAX.attendance)===0&&
       safeNum(r.nightAttendance,INPUT_MAX.nightAttendance)===0&&
       dailyTotal(r,emp).total>0){
      const key=nm+'|出勤なしの金額|noatt';cnt[key]=(cnt[key]||0)+1;
    }
    // 1日に1人工を超える出勤はありえない（超えた分は残業で入れる）。
    // 以前は 1.5 と 2 を選べたため、日給の2倍が割増なしで計上された記録が残りうる。
    // 過去の請求額を勝手に書き換えないよう、計算はそのままにして知らせるだけにする。
    if(emp&&(safeNum(r.attendance,INPUT_MAX.attendance)>1||
             safeNum(r.nightAttendance,INPUT_MAX.nightAttendance)>1)){
      const key=nm+'|1人工超え|overatt';cnt[key]=(cnt[key]||0)+1;
    }
    if(!emp)cnt[nm+'|所属なし']=(cnt[nm+'|所属なし']||0)+1;
  });
  // 発行済みの控えに同じ請求番号が複数あると、元請けの経理で取り違えが起きる。
  // 別の端末で発行した控えを復元で併合すると起こりうる。
  // 控えは消せない（電子帳簿保存法）ので、消さずに知らせる。
  const noSeen=new Map();
  (STATE.invoiceLog||[]).forEach(l=>{
    if(!l||l.voidOf||!l.invoiceNo)return;
    noSeen.set(l.invoiceNo,(noSeen.get(l.invoiceNo)||0)+1);
  });
  [...noSeen.entries()].filter(([,n])=>n>1).forEach(([no,n])=>{
    out.push({who:no,what:'同じ請求番号',days:n,kind:'dupno'});
  });
  Object.entries(cnt).forEach(([k,n])=>{
    const [who,what,kind]=k.split('|');out.push({who,what,days:n,kind:kind||'over'});
  });
  return out;
}
function renderDataHealth(){
  const box=$('data-health');if(!box)return;
  const iss=dataIssues();
  if(!iss.length){box.innerHTML='';box.style.display='none';return;}
  box.style.display='block';
  // 種類ごとに文章を変える。以前は全部「上限を超えた日が◯日」に流し込んでいたため、
  // 「出勤が無いのに金額がついている」が上限を超えた、という意味の通らない文になっていた。
  const noAtt=iss.filter(i=>i.kind==='noatt');
  const overAtt=iss.filter(i=>i.kind==='overatt');
  const dupNo=iss.filter(i=>i.kind==='dupno');
  const other=iss.filter(i=>['noatt','overatt','dupno'].indexOf(i.kind)<0);
  const parts=[];
  if(other.length)parts.push(`<div class="warn-card"><b>入力値に異常があります</b><br>
    ${other.map(i=>i.days
      ? `${esc(i.who)} の「${esc(i.what)}」が上限を超えた日が ${i.days} 日あります`
      : `${esc(i.who)} の「${esc(i.what)}」が ${yen(i.val)}（上限 ${yen(i.max)}）です`).join('<br>')}
    <br>桁の打ち間違いの可能性があります。金額は安全な値に丸めて計算していますが、
    正しい値に直してください。</div>`);
  if(noAtt.length)parts.push(`<div class="warn-card"><b>出勤の無い日に金額がついています</b><br>
    ${noAtt.map(i=>`${esc(i.who)} に ${i.days} 日あります`).join('<br>')}
    <br>日付を打ち間違えた可能性があります。そのままだと請求額に入ります。
    勤怠タブで、出勤を入れるか金額を0にしてください。</div>`);
  if(overAtt.length)parts.push(`<div class="warn-card"><b>1日に1人工を超えた記録があります</b><br>
    ${overAtt.map(i=>`${esc(i.who)} に ${i.days} 日あります`).join('<br>')}
    <br>1日は1人工までで、超えた分は残業時間で入れます。
    以前のアプリでは 1.5 や 2 を選べたため、その分に残業の割増がついていません。
    金額はそのままにしてあります。直す場合は勤怠タブで入れ直してください。</div>`);
  if(dupNo.length)parts.push(`<div class="warn-card"><b>同じ請求番号の控えが複数あります</b><br>
    ${dupNo.map(i=>`${esc(i.who)} が ${i.days} 件`).join('<br>')}
    <br>別の端末で発行した控えを復元でまとめた可能性があります。
    元請けに同じ番号の請求書が届いていないか確認してください。
    控えは記録として残す必要があるため、消していません。</div>`);
  box.innerHTML=parts.join('');
}

/* ---------- 発行履歴 ---------- */
function renderInvoiceLog(){
  const list=$('log-list');if(!list)return;
  if(!STATE.invoiceLog.length){
    list.innerHTML=`<div class="empty" style="padding:22px 12px;">${ART.log}<b>まだ発行履歴はありません</b><br>請求タブで「保存・印刷」すると記録されます</div>`;
    return;
  }
  list.innerHTML=STATE.invoiceLog.slice().reverse().map(o=>{
    const dt=new Date(o.issuedAt);
    const stamp=`${dt.getFullYear()}/${pad2(dt.getMonth()+1)}/${pad2(dt.getDate())} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
    const cancellation=STATE.invoiceLog.find(x=>x&&x.voidOf===o.id);
    const isVoided=!!o.voided||!!cancellation;
    const voidReason=o.voidReason||(cancellation&&cancellation.voidReason)||'';
    const voidOperator=o.voidOperator||(cancellation&&cancellation.voidOperator)||'';
    return `<div class="log-item${isVoided?' void':''}">
      <div class="log-top">
        <span class="log-no">No. ${esc(o.invoiceNo)}${isVoided?'<span class="log-tag">取消済</span>':''}</span>
        <span class="log-amt">${yen(o.total)}</span>
      </div>
      <div class="log-meta">${esc(o.clientName)} 御中　／　${esc(o.period.periodLabel)}<br>発行 ${stamp}　${esc(issueFileName(o))}${isVoided&&voidReason?'<br>取消理由：'+esc(voidReason):''}${isVoided&&voidOperator?'<br>取消担当：'+esc(voidOperator):''}</div>
      <div class="log-btns">
        <button type="button" onclick="reopenIssue('${o.id}')">再表示・再印刷</button>
        ${isVoided?'':`<button type="button" class="danger" onclick="voidIssue('${o.id}')">取り消す</button>`}
      </div>
    </div>`;
  }).join('');
}
/* 履歴から再表示（発行時点のスナップショットから描画する） */
function reopenIssue(id){
  const o=STATE.invoiceLog.find(x=>x.id===id);
  if(!o||!o.snapshot){toast('⚠️ 履歴が見つかりません');return;}
  const {settings,reports}=o.snapshot;
  const period={start:o.period.start,end:o.period.end,label:o.period.label,periodLabel:o.period.periodLabel};
  const opt={settings,invoiceNo:o.invoiceNo,issueDate:o.issueDate};
  showPreview(
    buildInvoiceHTML(reports,period,o.batch,'screen',opt),
    buildInvoiceHTML(reports,period,o.batch,'print',opt),
    o,true   // 既に記録済みなので二重に記録しない
  );
}
window.reopenIssue=reopenIssue;
/* 取消は「削除」ではなく取消記録の追記で行う（真実性の確保要件） */
async function voidIssue(id){
  const o=STATE.invoiceLog.find(x=>x.id===id);
  if(!o||o.voided||STATE.invoiceLog.some(x=>x&&x.voidOf===o.id))return;
  const reason=prompt('取り消す理由を入力してください（記録として残ります）');
  if(reason===null)return;
  const operator=prompt('処理担当者名を入力してください（記録として残ります）');
  if(operator===null)return;
  if(!operator.trim()){toast('⚠️ 処理担当者名を入力してください');return;}
  const voidedAt=new Date().toISOString();
  const cancellation={
    id:uid(), issuedAt:voidedAt, invoiceNo:o.invoiceNo+'-取消',
    issueDate:o.issueDate, period:JSON.parse(JSON.stringify(o.period)),
    clientName:o.clientName, issuerName:o.issuerName,
    subtotal:-o.subtotal, tax:-o.tax, taxRate:o.taxRate, total:-o.total,
    batch:o.batch, voided:true, voidReason:reason||'（理由未記入）',
    voidOperator:operator.trim(),voidedAt,voidOf:o.id,snapshot:null
  };
  STATE.invoiceLog.push(cancellation);
  try{await saveInvoiceLog();}
  catch(e){const i=STATE.invoiceLog.lastIndexOf(cancellation);if(i>=0)STATE.invoiceLog.splice(i,1);toast('⚠️ 取消記録を保存できませんでした。取消は成立していません');return;}
  renderInvoiceLog();
  toast('取消記録を追記しました');
}
window.voidIssue=voidIssue;

/* 事務処理規程（国税庁のひな形に沿った内容）を生成して保存 */
$('rule-btn').addEventListener('click',()=>{
  const s=STATE.settings;
  const name=s.issuer.companyName||'（自社名を設定してください）';
  const today=new Date();
  const txt=`電子取引データの訂正及び削除の防止に関する事務処理規程

（目的）
第1条　この規程は、電子計算機を使用して作成する国税関係帳簿書類の保存方法の
特例に関する法律第7条に定められた電子取引の取引情報に係る電磁的記録の保存
義務を履行するため、${name}（以下「当方」という。）における電子取引の取引
情報に係る電磁的記録の訂正及び削除の防止に関する事項を定め、その適正な保存
を目的とする。

（適用範囲）
第2条　この規程は、当方の行う全ての電子取引に係る電磁的記録について適用する。

（管理責任者）
第3条　電子取引の取引情報に係る電磁的記録の管理責任者は、${name}の代表者と
する。

（電子取引の範囲）
第4条　当方における電子取引の範囲は次のとおりとする。
　一　電子メール及びメッセージアプリを利用した請求書等の授受
　二　インターネット上のサービスを利用した請求書等の授受
　三　アプリケーションにより作成し電磁的に交付した請求書等

（取引データの保存）
第5条　電子取引により授受した取引データは、取引の相手先、取引年月日及び取引
金額により検索できる状態で保存する。ファイル名は「日付＿金額＿取引先」の
形式とする。

（対象データの訂正及び削除の禁止）
第6条　保存する取引データについては、原則として訂正及び削除をしてはならない。

（訂正削除を行う場合）
第7条　業務処理上やむを得ない理由により訂正又は削除を行う場合は、管理責任者
の承認を得たうえで、訂正又は削除の年月日、理由及び内容を記録として残し、
当該記録を取引データと合わせて保存する。取消しを行う場合は、元の記録を
削除せず、取消しの記録を追加することにより行う。

（本アプリの位置付け）
第8条　「日給管理・請求書」アプリは、発行時点のスナップショット及び取消記録を
保存するための運用補助機能として使用する。本アプリにはバックアップ復元及び
全データ削除の機能があるため、本アプリ単体を「訂正削除ができないシステム」と
して扱わない。法令上必要な保存期間、検索性その他の要件は、本規程に沿って
当方の責任で運用する。

（附則）
この規程は、${today.getFullYear()}年${today.getMonth()+1}月${today.getDate()}日から施行する。
`;
  const blob=new Blob([txt],{type:'text/plain;charset=utf-8'});
  const url=URL.createObjectURL(blob);const a=document.createElement('a');
  a.href=url;a.download='事務処理規程_電子取引データの訂正削除の防止.txt';
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),1500);
  toast('事務処理規程を保存しました');
});

/* データ管理 */
function buildBackup(){return JSON.stringify({app:'日給管理・請求書',schemaVersion:BACKUP_SCHEMA_VERSION,version:APP_VERSION,exportedAt:new Date().toISOString(),employees:STATE.employees,records:STATE.records,settings:STATE.settings,invoiceLog:STATE.invoiceLog},null,2);}
$('export-btn').addEventListener('click',()=>{
  const blob=new Blob([buildBackup()],{type:'application/json'});
  const url=URL.createObjectURL(blob);const a=document.createElement('a');
  a.href=url;a.download=`salary-backup-${ymd(new Date().getFullYear(),new Date().getMonth()+1,new Date().getDate())}.json`;
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),1500);toast('バックアップを保存しました');
});
$('import-btn').addEventListener('click',()=>{
  const inp=document.createElement('input');inp.type='file';inp.accept='application/json,.json';
  // 画面に付けずに click() すると、ブラウザによってはファイル選択が開かない。
  // 見えない位置に置いてから開き、終わったら片付ける。
  inp.style.cssText='position:fixed;left:-9999px;width:1px;height:1px;opacity:0;';
  document.body.appendChild(inp);
  const cleanup=()=>{try{inp.remove();}catch(e){}};
  inp.addEventListener('change',async()=>{
    const f=inp.files&&inp.files[0];
    if(!f){cleanup();return;}
    try{
      if(f.size>50*1024*1024)throw new Error('ファイルが大きすぎます');
      const o=validateBackupPayload(JSON.parse(await f.text())),settings=mergeSettings(o.settings);
      // 発行履歴は追記のみの記録なので、置き換えずに併合する。
      // 古いバックアップを戻したときに、発行済みの控えが巻き戻るのを防ぐ。
      const invoiceLog=mergeInvoiceLogs(STATE.invoiceLog,o.invoiceLog);
      // 何がどう変わるかを見せてから決めさせる。選んだ瞬間に入れ替わるのを避ける
      if(!confirm(
        'バックアップから復元します。いまのデータは置き換わります。\n\n'+
        `　従業員　${STATE.employees.length}名 → ${o.employees.length}名\n`+
        `　勤怠　　${STATE.records.length}件 → ${o.records.length}件\n`+
        `　発行履歴　${STATE.invoiceLog.length}件 → ${invoiceLog.length}件（消さずに合わせます）\n\n`+
        'よろしいですか？'))return;
      // 全件検査後に1つのtransactionで保存。失敗時は現在のデータを残す。
      await idbSetMany([['employees',o.employees],['records',o.records],['settings',settings],['invoiceLog',invoiceLog],['ready',true]]);
      STATE.employees=o.employees;STATE.records=o.records;STATE.settings=settings;STATE.invoiceLog=invoiceLog;STATE.ready=true;invalidateIdx();
      toast('復元しました ✓');setTimeout(()=>location.reload(),700);
    }catch(e){toast('⚠️ 復元できません: '+(e&&e.message?e.message:'ファイルを読めませんでした'));}
    finally{cleanup();}
  });
  inp.click();
});
$('reset-btn').addEventListener('click',async()=>{
  if(!confirm('全データを削除しますか？元に戻せません。\n（先にバックアップ保存を推奨）'))return;
  await idbClear();try{localStorage.clear();}catch(e){}location.reload();
});
/* 「最新に更新」：以前は再読込するだけで、キャッシュ優先のため同じ古い内容が
   返っていた。キャッシュとService Workerを消してから取り直す。
   勤怠データ・設定・発行履歴は IndexedDB にあるので消えない。 */
$('reload-btn').addEventListener('click',async()=>{
  const btn=$('reload-btn');btn.disabled=true;btn.textContent='更新中…';
  try{
    if('caches'in window){const ks=await caches.keys();await Promise.all(ks.filter(k=>k.startsWith('invoice-')).map(k=>caches.delete(k)));}
    if('serviceWorker'in navigator){
      const reg=await navigator.serviceWorker.getRegistration();
      if(reg)await reg.unregister();
    }
  }catch(e){}
  // キャッシュを確実に外すため、問い合わせ文字列を付けて読み直す
  location.replace(location.pathname+'?u='+Date.now());
});

$('rep-send').addEventListener('click',sendReport);
$('rep-include').addEventListener('change',renderReportPreview);
$('rep-memo').addEventListener('input',renderReportPreview);
bindSettings();
