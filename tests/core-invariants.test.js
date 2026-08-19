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
    overtimeRate, safeNum, dailyTotal, recHasData,
    billingPeriod, calcTax, nextInvoiceNumber, daysInPeriod,
    periodReport, idx, invalidateIdx, validateBackupPayload, STATE,
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
  };
  context.globalThis = context;
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
  assert.ok(save >= 0, 'invoiceLog 保存を await していない');
  assert.ok(print > save, '保存完了より先に印刷へ進んでいる');
  assert.ok(rollback > save, '保存失敗時のメモリ上の履歴巻き戻しがない');
  assert.match(handler, /印刷は開始していません/);
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
