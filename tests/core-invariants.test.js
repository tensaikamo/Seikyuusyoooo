'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/*
 * app.js はブラウザUIと計算ロジックが1ファイルに同居している。
 * いきなり本体を分割すると既存動作を壊すリスクがあるため、まず BOOT より前の
 * 副作用のない計算部分だけを VM に読み込み、実際の本番関数をそのままテストする。
 * 将来 core モジュールへ分離したら、このローダーだけ差し替えればよい。
 */
function loadCore() {
  const appPath = path.join(__dirname, '..', 'app.js');
  const source = fs.readFileSync(appPath, 'utf8');
  const bootMarker = '/* ---------- BOOT ---------- */';
  const cut = source.indexOf(bootMarker);
  assert.notEqual(cut, -1, 'app.js の BOOT マーカーが見つからない');

  const prefix = source.slice(0, cut);
  const expose = `\n;globalThis.__core = {
    overtimeRate, safeNum, dailyTotal, recHasData, shouldApplyDefaultTransport,
    billingPeriod, calcTax, nextInvoiceNumber, daysInPeriod,
    periodReport, idx, invalidateIdx, validateBackupPayload, normalizeBackupSnapshot, STATE,
    INPUT_MAX, WAGE_MAX
  };`;

  const context = {
    console,
    Date,
    Math,
    JSON,
    Map,
    Set,
    String,
    Number,
    Array,
    Object,
    Intl,
    Promise,
    setTimeout,
    clearTimeout,
    // 利用ログの自動保存が module scope で setInterval を呼ぶ。
    // 検査では動かす必要が無いので、何もしないものを渡す。
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener: () => {},
  };
  context.globalThis = context;
  // アプリ本体は module scope でブラウザの API を触る。
  // 検査では計算部分だけを見たいので、何もしないものを渡す。
  context.window = context;
  context.self = context;
  context.addEventListener = () => {};
  context.removeEventListener = () => {};
  context.matchMedia = () => ({ matches: false, addEventListener: () => {} });
  context.document = { addEventListener: () => {}, getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [], documentElement: {}, body: {} };
  context.navigator = { userAgent: 'test', storage: {} };
  context.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  context.indexedDB = { open: () => ({}) };
  context.screen = { width: 390, height: 844 };
  vm.createContext(context);
  vm.runInContext(prefix + expose, context, { filename: 'app-core.js' });
  return context.__core;
}

const core = loadCore();

test('safeNum: 異常値・負値・上限超過を計算へ持ち込まない', () => {
  assert.equal(core.safeNum(NaN, 100), 0);
  assert.equal(core.safeNum(Infinity, 100), 0);
  assert.equal(core.safeNum(-1, 100), 0);
  assert.equal(core.safeNum(101, 100), 100);
  assert.equal(core.safeNum('42', 100), 42);
});

test('dailyTotal: 日勤 + 残業 + 車代の既存計算を固定する', () => {
  const emp = { dailyWage: 10000, nightWage: 0 };
  const rec = {
    attendance: 1,
    overtimeHours: 2,
    nightAttendance: 0,
    nightOvertimeHours: 0,
    transportFee: 1000,
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(core.dailyTotal(rec, emp))),
    {
      wage: 10000,
      ot: 3125,
      nwage: 0,
      not: 0,
      tr: 1000,
      autoTotal: 14125,
      total: 14125,
      overridden: false,
    }
  );
});

test('dailyTotal: 出勤0なら残業時間が残っていても残業代を請求しない', () => {
  const emp = { dailyWage: 16000, nightWage: 0 };
  const rec = {
    attendance: 0,
    overtimeHours: 8,
    nightAttendance: 0,
    nightOvertimeHours: 0,
    transportFee: 0,
  };
  const total = core.dailyTotal(rec, emp);
  assert.equal(total.ot, 0);
  assert.equal(total.total, 0);
});

test('dailyTotal: 夜勤も対応する区分に出勤がある場合だけ残業代を計上する', () => {
  const emp = { dailyWage: 10000, nightWage: 12000 };
  const rec = {
    attendance: 0,
    overtimeHours: 0,
    nightAttendance: 1,
    nightOvertimeHours: 2,
    transportFee: 1000,
  };
  const total = core.dailyTotal(rec, emp);
  assert.equal(total.nwage, 12000);
  assert.equal(total.not, 3750);
  assert.equal(total.total, 16750);
});

test('dailyTotal: 手入力合計は自動計算を上書きする', () => {
  const emp = { dailyWage: 10000, nightWage: 0 };
  const rec = {
    attendance: 1,
    overtimeHours: 2,
    nightAttendance: 0,
    nightOvertimeHours: 0,
    transportFee: 1000,
    manualTotal: 20000,
  };
  const total = core.dailyTotal(rec, emp);
  assert.equal(total.autoTotal, 14125);
  assert.equal(total.total, 20000);
  assert.equal(total.overridden, true);
});

test('nextInvoiceNumber: 旧形式を壊さず新形式だけを年次連番にする', () => {
  assert.equal(core.nextInvoiceNumber([], 2026), '2026-000001');
  const log = [
    { invoiceNo: '2026-08-001' },
    { invoiceNo: '2026-000001' },
    { invoiceNo: '2025-000099' },
    { invoiceNo: '2026-000003' },
    { invoiceNo: '2026-000003-取消' },
    { invoiceNo: '2026-08-ALL' },
  ];
  assert.equal(core.nextInvoiceNumber(log, 2026), '2026-000004');
  assert.equal(core.nextInvoiceNumber(log, 2027), '2027-000001');
});

test('calcTax: 請求書単位の税計算は切り捨て1回', () => {
  assert.equal(core.calcTax(10005, 10), 1000);
  assert.equal(core.calcTax(9999, 8), 799);
  assert.equal(core.calcTax(12345, 0), 0);
});

test('billingPeriod: 月末締めは暦月1日〜末日', () => {
  const p = core.billingPeriod(2026, 2, 31);
  assert.equal(p.start, '2026-02-01');
  assert.equal(p.end, '2026-02-28');
  assert.equal(core.daysInPeriod(p.start, p.end).length, 28);
});

test('billingPeriod: 20日締めは前年境界でも連続する', () => {
  const p = core.billingPeriod(2026, 1, 20);
  assert.equal(p.start, '2025-12-21');
  assert.equal(p.end, '2026-01-20');
  assert.equal(core.daysInPeriod(p.start, p.end).length, 31);
});

test('billingPeriod: 28日締めで2月末日を前月と二重計上しない', () => {
  const feb = core.billingPeriod(2026, 2, 28);
  const mar = core.billingPeriod(2026, 3, 28);
  assert.equal(feb.end, '2026-02-28');
  assert.equal(mar.start, '2026-03-01');
  assert.notEqual(feb.end, mar.start);
  assert.equal(core.daysInPeriod(mar.start, mar.end).length, 28);
});


test('billingPeriod: 1〜28日締めは月をまたいでも空白・重複がない', () => {
  const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  for (let closing = 1; closing <= 28; closing++) {
    for (let y = 2024; y <= 2030; y++) {
      for (let m = 1; m <= 12; m++) {
        const cur = core.billingPeriod(y, m, closing);
        const nextDate = new Date(y, m, 1);
        const next = core.billingPeriod(nextDate.getFullYear(), nextDate.getMonth()+1, closing);
        const dayAfterEnd = new Date(cur.end + 'T00:00:00');
        dayAfterEnd.setDate(dayAfterEnd.getDate()+1);
        assert.equal(
          next.start,
          iso(dayAfterEnd),
          `closing=${closing}, period=${y}-${String(m).padStart(2,'0')}`
        );
      }
    }
  }
});

test('periodReport: 同一従業員・同一日の重複レコードを二重請求しない', () => {
  const emp = { id: 'emp-1', name: 'A', dailyWage: 10000, nightWage: 0 };
  core.STATE.employees = [emp];
  core.STATE.records = [
    { id: 'r1', employeeId: 'emp-1', date: '2026-08-01', attendance: 1, overtimeHours: 0, nightAttendance: 0, nightOvertimeHours: 0, transportFee: 0 },
    { id: 'r2', employeeId: 'emp-1', date: '2026-08-01', attendance: 1, overtimeHours: 0, nightAttendance: 0, nightOvertimeHours: 0, transportFee: 0 },
  ];
  core.invalidateIdx();
  const rep = core.periodReport(emp, '2026-08-01', '2026-08-31');
  assert.equal(rep.grandTotal, 10000);
});


test('発行履歴の永続化完了後にだけ印刷へ進む', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const start = src.indexOf("$('pv-print').addEventListener('click',async()=>{");
  assert.notEqual(start, -1, '印刷ハンドラが async ではない');
  const end = src.indexOf("\n});", start);
  assert.notEqual(end, -1, '印刷ハンドラ終端が見つからない');
  const handler = src.slice(start, end);
  const save = handler.indexOf('await saveInvoiceLog();');
  const print = handler.indexOf('window.print();');
  const rollback = handler.indexOf('STATE.invoiceLog.splice(i,1);');
  const activationGuard = handler.indexOf('navigator.userActivation');
  assert.ok(save >= 0, 'invoiceLog 保存を await していない');
  assert.ok(print > save, '保存完了より先に印刷へ進んでいる');
  assert.ok(rollback > save, '保存失敗時のメモリ上の履歴巻き戻しがない');
  assert.ok(activationGuard > save && activationGuard < print, '保存待ちでユーザー操作状態が失効した場合の印刷フォールバックがない');
  assert.match(handler, /印刷は開始していません/);
  assert.match(handler, /発行履歴は保存済みです/);
});


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
  high.schemaVersion = 1;
  high.records[0].transportFee = 100001;
  assert.throws(() => core.validateBackupPayload(high), /範囲外/);
  const future = sampleBackup();
  future.schemaVersion = 999;
  assert.throws(() => core.validateBackupPayload(future), /復元できません/);
});

function sampleInvoiceSnapshot() {
  return {
    settings: { defaultTransportFee: 1000, taxRate: 10, closingDay: 31, monthlyGoal: 0, issuer: { companyName: '発行者' }, client: { companyName: '取引先' }, bank: {} },
    reports: [{
      emp: { id: 'snap_emp', name: 'A', dailyWage: 10000, nightWage: 0, createdAt: '2026-08-01T00:00:00.000Z' },
      rep: {
        employeeId: 'snap_emp', totalAttendance: 1, totalNightAttendance: 0,
        totalDailyWage: 10000, totalOvertimePay: 0, totalNightWage: 0,
        totalNightOvertimePay: 0, totalTransportFee: 1000, grandTotal: 11000,
        records: [{ id: 'snap_rec', employeeId: 'snap_emp', date: '2026-08-01', attendance: 1, overtimeHours: 0, nightAttendance: 0, nightOvertimeHours: 0, transportFee: 1000 }]
      }
    }]
  };
}

function sampleIssue(snapshot) {
  return {
    id: 'issue1', issuedAt: '2026-08-02T00:00:00.000Z', invoiceNo: '2026-000001', issueDate: '2026年8月2日',
    period: { start: '2026-08-01', end: '2026-08-31', label: '2026年8月1日〜2026年8月31日', periodLabel: '2026年8月分' },
    clientName: '取引先', issuerName: '発行者', subtotal: 11000, tax: 1100, taxRate: 10, total: 12100,
    batch: false, voided: false, voidReason: '', snapshot
  };
}

test('validateBackupPayload: schemaVersionなしの旧ライブデータは上限導入前のraw値を保持できる', () => {
  const legacy = sampleBackup();
  legacy.employees[0].dailyWage = 2000000;
  legacy.records[0].overtimeHours = 100;
  legacy.records[0].nightOvertimeHours = 100;
  legacy.records[0].transportFee = 1000000;
  legacy.records[0].manualTotal = 50000000;
  const out = core.validateBackupPayload(legacy);
  assert.equal(out.employees[0].dailyWage, 2000000);
  assert.equal(out.records[0].overtimeHours, 100);
  assert.equal(out.records[0].transportFee, 1000000);
  assert.equal(out.records[0].manualTotal, 50000000);

  const strict = sampleBackup();
  strict.schemaVersion = 1;
  strict.employees[0].dailyWage = 2000000;
  strict.records[0].overtimeHours = 100;
  strict.records[0].transportFee = 1000000;
  strict.records[0].manualTotal = 50000000;
  assert.throws(() => core.validateBackupPayload(strict), /範囲外/);
});

test('validateBackupPayload: schemaVersionなしの旧設定値は上限導入前のraw値を保持し、新schemaでは拒否する', () => {
  const legacy = sampleBackup();
  legacy.settings.defaultTransportFee = 1000000;
  legacy.settings.monthlyGoal = 2000000000000;
  const out = core.validateBackupPayload(legacy);
  assert.equal(out.settings.defaultTransportFee, 1000000);
  assert.equal(out.settings.monthlyGoal, 2000000000000);

  const strictTransport = sampleBackup();
  strictTransport.schemaVersion = 1;
  strictTransport.settings.defaultTransportFee = 1000000;
  assert.throws(() => core.validateBackupPayload(strictTransport), /範囲外/);

  const strictGoal = sampleBackup();
  strictGoal.schemaVersion = 1;
  strictGoal.settings.monthlyGoal = 2000000000000;
  assert.throws(() => core.validateBackupPayload(strictGoal), /範囲外/);
});

test('validateBackupPayload: 発行スナップショット内部も数値型まで検証・正規化する', () => {
  const good = sampleBackup();
  good.invoiceLog = [sampleIssue(sampleInvoiceSnapshot())];
  const out = core.validateBackupPayload(good);
  assert.equal(out.invoiceLog[0].snapshot.settings.taxRate, 10);
  assert.equal(out.invoiceLog[0].snapshot.reports[0].rep.totalAttendance, 1);

  const badTax = sampleBackup();
  const snapTax = sampleInvoiceSnapshot();
  snapTax.settings.taxRate = '<img src=x onerror=alert(1)>';
  badTax.invoiceLog = [sampleIssue(snapTax)];
  assert.throws(() => core.validateBackupPayload(badTax), /数値が範囲外/);

  const badReport = sampleBackup();
  const snapReport = sampleInvoiceSnapshot();
  snapReport.reports[0].rep.totalAttendance = '<svg onload=alert(1)>';
  badReport.invoiceLog = [sampleIssue(snapReport)];
  assert.throws(() => core.validateBackupPayload(badReport), /数値が範囲外/);
});

test('validateBackupPayload: snapshot集計値と発行金額の改ざんを拒否する', () => {
  const badAggregate = sampleBackup();
  const snapAggregate = sampleInvoiceSnapshot();
  snapAggregate.reports[0].rep.grandTotal = 999999;
  badAggregate.invoiceLog = [sampleIssue(snapAggregate)];
  assert.throws(() => core.validateBackupPayload(badAggregate), /内訳合計と合計金額が一致/);

  const badIssue = sampleBackup();
  const issue = sampleIssue(sampleInvoiceSnapshot());
  issue.subtotal = 999999;
  badIssue.invoiceLog = [issue];
  assert.throws(() => core.validateBackupPayload(badIssue), /スナップショットと一致/);
});

test('validateBackupPayload: 取消元・取消金額・重複取消の整合性を検証する', () => {
  const base = sampleIssue(sampleInvoiceSnapshot());
  const cancellation = {
    id: 'cancel1', issuedAt: '2026-08-03T00:00:00.000Z', invoiceNo: '2026-000001-取消', issueDate: base.issueDate,
    period: { ...base.period }, clientName: base.clientName, issuerName: base.issuerName,
    subtotal: -base.subtotal, tax: -base.tax, taxRate: base.taxRate, total: -base.total,
    batch: false, voided: true, voidReason: '訂正', voidOperator: '担当者', voidedAt: '2026-08-03T00:00:00.000Z', voidOf: base.id, snapshot: null
  };
  const good = sampleBackup(); good.invoiceLog = [base, cancellation];
  assert.equal(core.validateBackupPayload(good).invoiceLog.length, 2);

  const missing = sampleBackup(); missing.invoiceLog = [{ ...cancellation, voidOf: 'missing_issue' }];
  assert.throws(() => core.validateBackupPayload(missing), /取消参照が不正/);

  const wrongAmount = sampleBackup(); wrongAmount.invoiceLog = [base, { ...cancellation, total: -1 }];
  assert.throws(() => core.validateBackupPayload(wrongAmount), /取消金額が元の記録と一致/);

  const duplicate = sampleBackup(); duplicate.invoiceLog = [base, cancellation, { ...cancellation, id: 'cancel2' }];
  assert.throws(() => core.validateBackupPayload(duplicate), /複数の取消記録/);
});

test('validateBackupPayload: schemaVersionなしの旧発行snapshotは当時の計算結果を保存したまま復元できる', () => {
  const legacy = sampleBackup();
  const snap = sampleInvoiceSnapshot();
  const rec = snap.reports[0].rep.records[0];
  rec.attendance = 0; rec.overtimeHours = 2; rec.transportFee = 1000;
  const rep = snap.reports[0].rep;
  rep.totalAttendance = 0; rep.totalDailyWage = 0; rep.totalOvertimePay = 3125; rep.totalTransportFee = 1000; rep.grandTotal = 4125;
  const issue = sampleIssue(snap);
  issue.subtotal = 4125; issue.tax = 412; issue.total = 4537;
  legacy.invoiceLog = [issue];
  assert.doesNotThrow(() => core.validateBackupPayload(legacy));

  const strict = sampleBackup(); strict.schemaVersion = 1; strict.invoiceLog = [issue];
  assert.throws(() => core.validateBackupPayload(strict), /集計値が勤怠明細と一致/);
});

test('validateBackupPayload: 旧発行snapshot内の過去設定値は証跡として保持し、新schemaでは現行上限を適用する', () => {
  const legacy = sampleBackup();
  const snap = sampleInvoiceSnapshot();
  snap.settings.defaultTransportFee = 250000;
  const issue = sampleIssue(snap);
  legacy.invoiceLog = [issue];
  assert.doesNotThrow(() => core.validateBackupPayload(legacy));

  const strict = sampleBackup(); strict.schemaVersion = 1; strict.invoiceLog = [issue];
  assert.throws(() => core.validateBackupPayload(strict), /車代の初期値.*範囲外/);
});

test('validateBackupPayload: 旧発行snapshotの過去上限超過値は履歴として保持し、新schemaでは拒否する', () => {
  const legacy = sampleBackup();
  const snap = sampleInvoiceSnapshot();
  snap.reports[0].emp.dailyWage = 2000000;
  const rep = snap.reports[0].rep;
  rep.totalDailyWage = 2000000; rep.totalTransportFee = 1000; rep.totalOvertimePay = 0; rep.grandTotal = 2001000;
  const issue = sampleIssue(snap); issue.subtotal = 2001000; issue.tax = 200100; issue.total = 2201100;
  legacy.invoiceLog = [issue];
  assert.doesNotThrow(() => core.validateBackupPayload(legacy));

  const strict = sampleBackup(); strict.schemaVersion = 1; strict.invoiceLog = [issue];
  assert.throws(() => core.validateBackupPayload(strict), /範囲外/);
});

test('validateBackupPayload: 発行スナップショットのID不整合と重複日を拒否する', () => {
  const mismatch = sampleBackup();
  const snapMismatch = sampleInvoiceSnapshot();
  snapMismatch.reports[0].rep.employeeId = 'other_emp';
  mismatch.invoiceLog = [sampleIssue(snapMismatch)];
  assert.throws(() => core.validateBackupPayload(mismatch), /形式が不正|IDが一致/);

  const duplicate = sampleBackup();
  duplicate.schemaVersion = 1;
  const snapDuplicate = sampleInvoiceSnapshot();
  snapDuplicate.reports[0].rep.records.push({ ...snapDuplicate.reports[0].rep.records[0], id: 'snap_rec2' });
  duplicate.invoiceLog = [sampleIssue(snapDuplicate)];
  assert.throws(() => core.validateBackupPayload(duplicate), /同じ日の勤怠が重複/);
});

test('validateBackupPayload: 発行履歴の取引先と請求期間をsnapshotと照合する', () => {
  const party = sampleBackup();
  const partyIssue = sampleIssue(sampleInvoiceSnapshot()); partyIssue.clientName = '別会社'; party.invoiceLog = [partyIssue];
  assert.throws(() => core.validateBackupPayload(party), /取引先または発行者がスナップショットと一致/);

  const period = sampleBackup();
  const periodSnap = sampleInvoiceSnapshot(); periodSnap.reports[0].rep.records[0].date = '2026-09-01';
  const periodIssue = sampleIssue(periodSnap); period.invoiceLog = [periodIssue];
  assert.throws(() => core.validateBackupPayload(period), /請求期間外/);
});

test('復元処理は検証完了後に1トランザクションで永続化する', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const start = src.indexOf("$('import-btn').addEventListener('click',()=>{");
  assert.notEqual(start, -1);
  const body = src.slice(start, src.indexOf("$('reset-btn')", start));
  const validate = body.indexOf('validateBackupPayload(');
  const persist = body.indexOf('await idbSetMany([');
  const mutate = body.indexOf('STATE.employees=o.employees');
  assert.ok(validate >= 0 && persist > validate && mutate > persist, '検証→永続化→STATE反映の順になっていない');
});


test('最新更新は当アプリのcacheとservice workerだけを対象にする', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const start = src.indexOf("$('reload-btn').addEventListener('click',async()=>{");
  assert.notEqual(start, -1);
  const body = src.slice(start, src.indexOf('\nbindSettings();', start));
  assert.match(body, /filter\(k=>k\.startsWith\('invoice-'\)\)/);
  assert.match(body, /navigator\.serviceWorker\.getRegistration\(\)/);
  assert.doesNotMatch(body, /getRegistrations\(\)/);
  assert.doesNotMatch(body, /Promise\.all\(ks\.map\(k=>caches\.delete\(k\)\)\)/);
});


test('取消は元の発行記録を変更せず追記保存する', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const start = src.indexOf('async function voidIssue(id){');
  assert.notEqual(start, -1);
  const end = src.indexOf('\nwindow.voidIssue=voidIssue;', start);
  const body = src.slice(start, end);
  assert.doesNotMatch(body, /o\.voided\s*=\s*true/);
  assert.doesNotMatch(body, /o\.voidReason\s*=/);
  assert.match(body, /voidOperator:operator\.trim\(\)/);
  assert.match(body, /STATE\.invoiceLog\.push\(cancellation\)/);
  assert.match(body, /await saveInvoiceLog\(\)/);
  assert.match(body, /取消は成立していません/);
});

test('事務処理規程はアプリを削除不能システムと誤表現しない', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const start = src.indexOf("$('rule-btn').addEventListener('click',()=>{");
  const end = src.indexOf('/* データ管理 */', start);
  const body = src.slice(start, end);
  assert.match(body, /処理担当者/);
  assert.match(body, /本アプリ単体を「訂正削除ができないシステム」と/);
  assert.doesNotMatch(body, /削除できない形で管理される/);
});


test('角印は印刷HTMLにも埋め込まれる', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(src, /const printSeal=\(cssMode==='print'&&issuer\.companyName\)/);
  assert.match(src, /\$\{printSeal\}/);
  assert.match(src, /#print-root \.inv-doc-seal\{/);
  assert.match(src, /#print-root \.inv-doc-seal \.seal\{/);
});


test('shouldApplyDefaultTransport: レコード作成済みでも休み→初出勤なら適用する', () => {
  const overtimeFirst = { attendance: 0, nightAttendance: 0, overtimeHours: 2, transportFee: 0 };
  assert.equal(core.shouldApplyDefaultTransport(overtimeFirst, 'attendance', 1), true);
  assert.equal(core.shouldApplyDefaultTransport(overtimeFirst, 'nightAttendance', 1), true);
  assert.equal(core.shouldApplyDefaultTransport(overtimeFirst, 'overtimeHours', 3), false);
});

test('shouldApplyDefaultTransport: 既存出勤・既存車代は上書き対象にしない', () => {
  assert.equal(core.shouldApplyDefaultTransport({ attendance: 1, nightAttendance: 0, transportFee: 0 }, 'nightAttendance', 1), false);
  assert.equal(core.shouldApplyDefaultTransport({ attendance: 0, nightAttendance: 0, transportFee: 500 }, 'attendance', 1), false);
});


test('リリース表記は実際の印刷/PDF保存方式と一致する', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.match(app, /const APP_VERSION='1\.16\.0';/);
  assert.doesNotMatch(app, /A4 2ページPDF/);
  assert.doesNotMatch(html, /A4 2ページPDF/);
  assert.equal(manifest.description.includes('A4 2ページPDF'), false);
  assert.match(html, /まとめ請求書を保存・印刷/);
  assert.match(sw, /const CACHE='invoice-v29';/);
});


test('Service Workerのactivateは当アプリの旧cacheだけを削除する', () => {
  const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.match(sw, /filter\(k=>k\.startsWith\('invoice-'\)&&k!==CACHE\)/);
  assert.doesNotMatch(sw, /filter\(k=>k!==CACHE\)/);
});
