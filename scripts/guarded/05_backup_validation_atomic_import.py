from pathlib import Path

APP = Path('app.js')
TEST = Path('tests/core-invariants.test.js')

app = APP.read_text(encoding='utf-8')

# 1) Add an atomic multi-key IndexedDB write helper.
old_idb = """function idbSet(k,v){return db().then(d=>new Promise((res,rej)=>{const t=d.transaction(STORE,'readwrite');t.objectStore(STORE).put(v,k);t.oncomplete=()=>res();t.onerror=()=>rej(t.error);}));}\nfunction idbClear(){return db().then(d=>new Promise((res,rej)=>{const t=d.transaction(STORE,'readwrite');t.objectStore(STORE).clear();t.oncomplete=()=>res();t.onerror=()=>rej(t.error);}));}\n"""
new_idb = """function idbSet(k,v){return db().then(d=>new Promise((res,rej)=>{const t=d.transaction(STORE,'readwrite');t.objectStore(STORE).put(v,k);t.oncomplete=()=>res();t.onerror=()=>rej(t.error);}));}\n/* 復元時は複数キーを1つのtransactionで更新する。途中失敗で employees だけ新しく、\n   records は古い、といった半端な復元状態を作らない。 */\nfunction idbSetMany(entries){return db().then(d=>new Promise((res,rej)=>{\n  const t=d.transaction(STORE,'readwrite'),s=t.objectStore(STORE);\n  entries.forEach(([k,v])=>s.put(v,k));\n  t.oncomplete=()=>res();t.onerror=()=>rej(t.error);t.onabort=()=>rej(t.error||new Error('transaction aborted'));\n}));}\nfunction idbClear(){return db().then(d=>new Promise((res,rej)=>{const t=d.transaction(STORE,'readwrite');t.objectStore(STORE).clear();t.oncomplete=()=>res();t.onerror=()=>rej(t.error);}));}\n"""
if app.count(old_idb) != 1:
    raise SystemExit(f'ABORT: expected IndexedDB helper anchor once, found {app.count(old_idb)}')
app = app.replace(old_idb, new_idb, 1)

# 2) Add pure backup validation/normalization before BOOT so it is regression-testable without DOM.
boot_anchor = """/* ---------- BOOT ---------- */\n"""
validation = r"""/* ---------- backup validation（STATEへ触る前に全件検査） ---------- */
const BACKUP_SCHEMA_VERSION=1;
function backupFail(msg){throw new Error(msg);}
function backupObj(v,label){if(!v||typeof v!=='object'||Array.isArray(v))backupFail(`${label}の形式が不正です`);return v;}
function backupText(v,label,max=500){
  if(v==null)return '';
  if(typeof v!=='string')backupFail(`${label}は文字列ではありません`);
  if(v.length>max)backupFail(`${label}が長すぎます`);
  return v;
}
function backupNoMarkup(v,label,max=120){
  const s=backupText(v,label,max);
  if(/[<>]/.test(s))backupFail(`${label}に使用できない文字があります`);
  return s;
}
function backupId(v,label){
  if(typeof v!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(v))backupFail(`${label}のIDが不正です`);
  return v;
}
function backupNum(v,label,min,max,integer=false){
  const n=Number(v);
  if(!Number.isFinite(n)||n<min||n>max||(integer&&!Number.isInteger(n)))backupFail(`${label}の数値が範囲外です`);
  return n;
}
function backupDate(v,label){
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))backupFail(`${label}の日付形式が不正です`);
  const [y,m,d]=v.split('-').map(Number),dt=new Date(y,m-1,d);
  if(dt.getFullYear()!==y||dt.getMonth()+1!==m||dt.getDate()!==d)backupFail(`${label}に存在しない日付があります`);
  return v;
}
function normalizeBackupSettings(raw){
  const s=raw==null?{}:backupObj(raw,'設定');
  const issuer=s.issuer==null?{}:backupObj(s.issuer,'発行者設定');
  const client=s.client==null?{}:backupObj(s.client,'請求先設定');
  const bank=s.bank==null?{}:backupObj(s.bank,'振込先設定');
  const tax=backupNum(s.taxRate??DEFAULT_SETTINGS.taxRate,'消費税率',0,100);
  if(![0,8,10].includes(tax))backupFail('消費税率は 0・8・10% のいずれかにしてください');
  return {
    defaultTransportFee:backupNum(s.defaultTransportFee??DEFAULT_SETTINGS.defaultTransportFee,'車代の初期値',0,INPUT_MAX.transportFee),
    taxRate:tax,
    closingDay:backupNum(s.closingDay??DEFAULT_SETTINGS.closingDay,'締め日',1,31,true),
    monthlyGoal:backupNum(s.monthlyGoal??DEFAULT_SETTINGS.monthlyGoal,'月間目標',0,1000000000000),
    issuer:{
      companyName:backupText(issuer.companyName,'自社名',200),postalCode:backupText(issuer.postalCode,'自社郵便番号',40),
      address:backupText(issuer.address,'自社住所',500),phone:backupText(issuer.phone,'電話番号',100),
      invoiceNumber:backupNoMarkup(issuer.invoiceNumber,'登録番号',100)
    },
    client:{
      companyName:backupText(client.companyName,'請求先名',200),postalCode:backupText(client.postalCode,'請求先郵便番号',40),
      address:backupText(client.address,'請求先住所',500),contactName:backupText(client.contactName,'担当者名',200)
    },
    bank:{
      bankName:backupText(bank.bankName,'銀行名',200),branchName:backupText(bank.branchName,'支店名',200),
      accountType:backupText(bank.accountType??DEFAULT_SETTINGS.bank.accountType,'口座種別',40),
      accountNumber:backupText(bank.accountNumber,'口座番号',100),accountHolder:backupText(bank.accountHolder,'口座名義',200)
    }
  };
}
function normalizeBackupIssue(raw,index){
  const o=backupObj(raw,`発行履歴${index+1}件目`);
  const period=backupObj(o.period,`発行履歴${index+1}件目の期間`);
  const issuedAt=backupText(o.issuedAt,`発行履歴${index+1}件目の発行日時`,80);
  if(!Number.isFinite(Date.parse(issuedAt)))backupFail(`発行履歴${index+1}件目の発行日時が不正です`);
  const start=backupDate(period.start,`発行履歴${index+1}件目の開始日`);
  const end=backupDate(period.end,`発行履歴${index+1}件目の終了日`);
  if(start>end)backupFail(`発行履歴${index+1}件目の期間が逆転しています`);
  let snapshot=null;
  if(o.snapshot!=null){
    snapshot=backupObj(o.snapshot,`発行履歴${index+1}件目のスナップショット`);
    if(!snapshot.settings||!Array.isArray(snapshot.reports))backupFail(`発行履歴${index+1}件目のスナップショット形式が不正です`);
    const serialized=JSON.stringify(snapshot);
    if(serialized.length>5000000)backupFail(`発行履歴${index+1}件目のスナップショットが大きすぎます`);
    snapshot=JSON.parse(serialized);
  }
  return {
    id:backupId(o.id,`発行履歴${index+1}件目`),issuedAt,
    invoiceNo:backupNoMarkup(o.invoiceNo,`発行履歴${index+1}件目の請求番号`,120),
    issueDate:backupNoMarkup(o.issueDate,`発行履歴${index+1}件目の発行日`,80),
    period:{start,end,label:backupNoMarkup(period.label,`発行履歴${index+1}件目の期間表示`,120),periodLabel:backupNoMarkup(period.periodLabel,`発行履歴${index+1}件目の請求月表示`,80)},
    clientName:backupText(o.clientName,`発行履歴${index+1}件目の取引先`,300),
    issuerName:backupText(o.issuerName,`発行履歴${index+1}件目の発行者`,300),
    subtotal:backupNum(o.subtotal,`発行履歴${index+1}件目の小計`,-1000000000000,1000000000000),
    tax:backupNum(o.tax,`発行履歴${index+1}件目の税額`,-1000000000000,1000000000000),
    taxRate:backupNum(o.taxRate,`発行履歴${index+1}件目の税率`,0,100),
    total:backupNum(o.total,`発行履歴${index+1}件目の合計`,-1000000000000,1000000000000),
    batch:!!o.batch,voided:!!o.voided,voidReason:backupText(o.voidReason,`発行履歴${index+1}件目の取消理由`,1000),
    ...(o.voidedAt?{voidedAt:backupText(o.voidedAt,`発行履歴${index+1}件目の取消日時`,80)}:{}),
    ...(o.voidOf?{voidOf:backupId(o.voidOf,`発行履歴${index+1}件目の取消元`)}:{}),
    snapshot
  };
}
function validateBackupPayload(raw){
  const o=backupObj(raw,'バックアップ');
  if(o.schemaVersion!=null&&Number(o.schemaVersion)!==BACKUP_SCHEMA_VERSION)backupFail('このバックアップ形式は現在のアプリでは復元できません');
  if(!Array.isArray(o.employees)||!Array.isArray(o.records))backupFail('従業員または勤怠データが見つかりません');
  const invoiceRaw=o.invoiceLog==null?[]:o.invoiceLog;
  if(!Array.isArray(invoiceRaw))backupFail('発行履歴の形式が不正です');
  if(o.employees.length>5000||o.records.length>500000||invoiceRaw.length>100000)backupFail('バックアップの件数が上限を超えています');

  const empIds=new Set();
  const employees=o.employees.map((rawEmp,i)=>{
    const e=backupObj(rawEmp,`従業員${i+1}件目`),id=backupId(e.id,`従業員${i+1}件目`);
    if(empIds.has(id))backupFail(`従業員IDが重複しています: ${id}`);empIds.add(id);
    const name=backupText(e.name,`従業員${i+1}件目の名前`,200);
    if(!name.trim())backupFail(`従業員${i+1}件目の名前が空です`);
    return {id,name,dailyWage:backupNum(e.dailyWage,`${name}の日給`,1,WAGE_MAX),nightWage:backupNum(e.nightWage??0,`${name}の夜間単価`,0,WAGE_MAX),createdAt:backupText(e.createdAt,`${name}の作成日時`,100)};
  });

  const recordIds=new Set(),dayKeys=new Set();
  const records=o.records.map((rawRec,i)=>{
    const r=backupObj(rawRec,`勤怠${i+1}件目`),id=backupId(r.id,`勤怠${i+1}件目`),employeeId=backupId(r.employeeId,`勤怠${i+1}件目の従業員`);
    if(recordIds.has(id))backupFail(`勤怠IDが重複しています: ${id}`);recordIds.add(id);
    if(!empIds.has(employeeId))backupFail(`勤怠${i+1}件目が存在しない従業員を参照しています`);
    const date=backupDate(r.date,`勤怠${i+1}件目`),dayKey=`${employeeId}|${date}`;
    if(dayKeys.has(dayKey))backupFail(`同じ従業員・同じ日の勤怠が重複しています: ${date}`);dayKeys.add(dayKey);
    const rec={id,employeeId,date,
      attendance:backupNum(r.attendance??0,`勤怠${i+1}件目の出勤数`,0,INPUT_MAX.attendance),
      overtimeHours:backupNum(r.overtimeHours??0,`勤怠${i+1}件目の残業時間`,0,INPUT_MAX.overtimeHours),
      nightAttendance:backupNum(r.nightAttendance??0,`勤怠${i+1}件目の夜勤出勤数`,0,INPUT_MAX.nightAttendance),
      nightOvertimeHours:backupNum(r.nightOvertimeHours??0,`勤怠${i+1}件目の夜間残業`,0,INPUT_MAX.nightOvertimeHours),
      transportFee:backupNum(r.transportFee??0,`勤怠${i+1}件目の車代`,0,INPUT_MAX.transportFee)};
    if(r.manualTotal!=null)rec.manualTotal=backupNum(r.manualTotal,`勤怠${i+1}件目の手入力合計`,0,INPUT_MAX.manualTotal);
    if(r.note!=null)rec.note=backupText(r.note,`勤怠${i+1}件目のメモ`,2000);
    return rec;
  });

  const logIds=new Set();
  const invoiceLog=invoiceRaw.map((x,i)=>{
    const issue=normalizeBackupIssue(x,i);
    if(logIds.has(issue.id))backupFail(`発行履歴IDが重複しています: ${issue.id}`);logIds.add(issue.id);
    return issue;
  });
  return {schemaVersion:BACKUP_SCHEMA_VERSION,employees,records,settings:normalizeBackupSettings(o.settings),invoiceLog};
}

"""
if app.count(boot_anchor) != 1:
    raise SystemExit(f'ABORT: expected BOOT anchor once, found {app.count(boot_anchor)}')
app = app.replace(boot_anchor, validation + boot_anchor, 1)

# 3) Version new backups explicitly, while validation remains backward compatible with backups that lack this field.
old_backup = """function buildBackup(){return JSON.stringify({app:'日給管理・請求書',version:APP_VERSION,exportedAt:new Date().toISOString(),employees:STATE.employees,records:STATE.records,settings:STATE.settings,invoiceLog:STATE.invoiceLog},null,2);}\n"""
new_backup = """function buildBackup(){return JSON.stringify({app:'日給管理・請求書',schemaVersion:BACKUP_SCHEMA_VERSION,version:APP_VERSION,exportedAt:new Date().toISOString(),employees:STATE.employees,records:STATE.records,settings:STATE.settings,invoiceLog:STATE.invoiceLog},null,2);}\n"""
if app.count(old_backup) != 1:
    raise SystemExit(f'ABORT: expected buildBackup source once, found {app.count(old_backup)}')
app = app.replace(old_backup, new_backup, 1)

# 4) Replace import with validate-first + one atomic IndexedDB transaction + state update after persistence.
old_import = """    try{\n      const o=JSON.parse(await f.text());\n      if(Array.isArray(o.employees))STATE.employees=o.employees;\n      if(Array.isArray(o.records))STATE.records=o.records;\n      if(o.settings)STATE.settings=mergeSettings(o.settings);\n      if(Array.isArray(o.invoiceLog))STATE.invoiceLog=o.invoiceLog;\n      STATE.ready=true;\n      await Promise.all([saveEmployees(),saveRecords(),saveSettings(),saveInvoiceLog(),saveReady()]);\n      toast('復元しました ✓');setTimeout(()=>location.reload(),700);\n    }catch(e){toast('⚠️ ファイルを読めませんでした');}\n"""
new_import = """    try{\n      const raw=JSON.parse(await f.text());\n      // ここで全件検査。失敗した時点では STATE / IndexedDB のどちらにも触れていない。\n      const o=validateBackupPayload(raw);\n      const settings=mergeSettings(o.settings);\n      await idbSetMany([\n        ['employees',o.employees],['records',o.records],['settings',settings],\n        ['invoiceLog',o.invoiceLog],['ready',true]\n      ]);\n      // 永続化が成功してからメモリ上の状態も切り替える。\n      STATE.employees=o.employees;STATE.records=o.records;STATE.settings=settings;\n      STATE.invoiceLog=o.invoiceLog;STATE.ready=true;invalidateIdx();\n      toast('復元しました ✓');setTimeout(()=>location.reload(),700);\n    }catch(e){toast('⚠️ 復元できません: '+(e&&e.message?e.message:'ファイルを読めませんでした'));}\n"""
if app.count(old_import) != 1:
    raise SystemExit(f'ABORT: expected import source once, found {app.count(old_import)}')
app = app.replace(old_import, new_import, 1)
APP.write_text(app, encoding='utf-8')

# 5) Expose validator and add regression cases.
test_src = TEST.read_text(encoding='utf-8')
old_expose = """    periodReport, idx, invalidateIdx, STATE,\n    INPUT_MAX, WAGE_MAX\n"""
new_expose = """    periodReport, idx, invalidateIdx, validateBackupPayload, STATE,\n    INPUT_MAX, WAGE_MAX\n"""
if test_src.count(old_expose) != 1:
    raise SystemExit(f'ABORT: expected validator expose anchor once, found {test_src.count(old_expose)}')
test_src = test_src.replace(old_expose, new_expose, 1)

name = "validateBackupPayload: 正常な旧形式バックアップを壊さず数値を正規化する"
if name not in test_src:
    test_src += r"""

function sampleBackup() {
  return {
    app: '日給管理・請求書',
    version: '1.6.4',
    employees: [{ id: 'emp1', name: 'A', dailyWage: '10000', nightWage: 0, createdAt: '2026-08-01T00:00:00.000Z' }],
    records: [{ id: 'rec1', employeeId: 'emp1', date: '2026-08-01', attendance: '1', overtimeHours: 0, nightAttendance: 0, nightOvertimeHours: 0, transportFee: '1000' }],
    settings: { defaultTransportFee: 1000, taxRate: 10, closingDay: 31, monthlyGoal: 0, issuer: {}, client: {}, bank: {} },
    invoiceLog: [],
  };
}

test('validateBackupPayload: 正常な旧形式バックアップを壊さず数値を正規化する', () => {
  const out = core.validateBackupPayload(sampleBackup());
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.employees[0].dailyWage, 10000);
  assert.equal(out.records[0].attendance, 1);
  assert.equal(out.records[0].transportFee, 1000);
});

test('validateBackupPayload: 同一従業員・同一日の重複勤怠を拒否する', () => {
  const b = sampleBackup();
  b.records.push({ ...b.records[0], id: 'rec2' });
  assert.throws(() => core.validateBackupPayload(b), /重複/);
});

test('validateBackupPayload: 存在しない従業員参照と危険なIDを拒否する', () => {
  const orphan = sampleBackup();
  orphan.records[0].employeeId = 'missing';
  assert.throws(() => core.validateBackupPayload(orphan), /存在しない従業員/);
  const unsafe = sampleBackup();
  unsafe.employees[0].id = "x');alert(1)//";
  unsafe.records[0].employeeId = unsafe.employees[0].id;
  assert.throws(() => core.validateBackupPayload(unsafe), /IDが不正/);
});

test('validateBackupPayload: 入力上限超過と未知の将来schemaを拒否する', () => {
  const high = sampleBackup();
  high.records[0].transportFee = 100001;
  assert.throws(() => core.validateBackupPayload(high), /範囲外/);
  const future = sampleBackup();
  future.schemaVersion = 999;
  assert.throws(() => core.validateBackupPayload(future), /復元できません/);
});

test('復元処理は検証完了後に1トランザクションで永続化する', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const start = src.indexOf("$('import-btn').addEventListener('click',()=>{");
  assert.notEqual(start, -1);
  const body = src.slice(start, src.indexOf("$('reset-btn')", start));
  const validate = body.indexOf('validateBackupPayload(raw)');
  const persist = body.indexOf('await idbSetMany([');
  const mutate = body.indexOf('STATE.employees=o.employees');
  assert.ok(validate >= 0 && persist > validate && mutate > persist, '検証→永続化→STATE反映の順になっていない');
});
"""
TEST.write_text(test_src, encoding='utf-8')
print('Validated atomic backup import applied safely.')
