'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const swSource = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function loadCore() {
  const cut = source.indexOf('/* ---------- BOOT ---------- */');
  assert.notEqual(cut, -1, 'BOOT marker is missing');
  const context = {
    console,
    Date,
    Math,
    Map,
    Set,
    JSON,
    Number,
    String,
    Array,
    Object,
    Promise,
    TextEncoder,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    window: { addEventListener() {} },
    document: { getElementById() { return null; }, activeElement: null },
    navigator: {},
    matchMedia: () => ({ matches: true }),
    indexedDB: { open() { throw new Error('IndexedDB must not be used in core tests'); } },
  };
  context.globalThis = context;
  vm.createContext(context);
  const expose = `\n;globalThis.__core={
    safeNum,dailyTotal,recHasData,ratesOn,payRates,payTotal,canonicalRecords,recordForDay,
    billingPeriod,daysInPeriod,calcTax,periodReport,payReport,shouldApplyDefaultTransport,
    idx,invalidateIdx,STATE,INPUT_MAX,WAGE_MAX,
    ...(typeof nextInvoiceNumber==='function'?{nextInvoiceNumber}:{}),
    ...(typeof normalizeRate==='function'?{normalizeRate}:{}),
    ...(typeof replaceWageHistoryFrom==='function'?{replaceWageHistoryFrom}:{}),
    ...(typeof validateBackupPayload==='function'?{validateBackupPayload}:{}),
    ...(typeof BACKUP_SCHEMA_VERSION==='number'?{BACKUP_SCHEMA_VERSION}:{})
  };`;
  vm.runInContext(source.slice(0, cut) + expose, context, { filename: 'app-core.js' });
  return context.__core;
}

const core = loadCore();

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function rng(seed = 0x51a7c0de) {
  let x = seed >>> 0;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x >>>= 0; x ^= x << 5; x >>>= 0; return x / 0x100000000; };
}

test('billing periods from closing day 1 through 28 are continuous', () => {
  for (let closing = 1; closing <= 28; closing++) {
    for (let year = 2024; year <= 2032; year++) {
      for (let month = 1; month <= 12; month++) {
        const current = core.billingPeriod(year, month, closing);
        const nextDate = new Date(year, month, 1);
        const next = core.billingPeriod(nextDate.getFullYear(), nextDate.getMonth() + 1, closing);
        const after = new Date(current.end + 'T00:00:00');
        after.setDate(after.getDate() + 1);
        assert.equal(next.start, iso(after), `${year}-${month}, closing=${closing}`);
      }
    }
  }
});

test('February 28 is not billed twice for a 28-day closing period', () => {
  const feb = core.billingPeriod(2026, 2, 28);
  const mar = core.billingPeriod(2026, 3, 28);
  assert.equal(feb.end, '2026-02-28');
  assert.equal(mar.start, '2026-03-01');
});

test('duplicate employee/day records cannot double invoice or double pay', () => {
  const emp = { id: 'emp_1', name: 'A', dailyWage: 20000, nightWage: 0, payWage: 15000, payNightWage: 0 };
  core.STATE.employees = [emp];
  core.STATE.records = [
    { id: 'r1', employeeId: emp.id, date: '2026-08-01', attendance: 2, overtimeHours: 0, nightAttendance: 0, nightOvertimeHours: 0, transportFee: 0 },
    { id: 'r2', employeeId: emp.id, date: '2026-08-01', attendance: 1, overtimeHours: 0, nightAttendance: 0, nightOvertimeHours: 0, transportFee: 0 },
  ];
  core.invalidateIdx();
  assert.equal(core.periodReport(emp, '2026-08-01', '2026-08-31').grandTotal, 20000);
  assert.equal(core.payReport(emp, '2026-08-01', '2026-08-31').grandTotal, 15000);
  assert.equal(core.canonicalRecords()[0].id, 'r2');
  assert.equal(core.recordForDay(emp.id, '2026-08-01').id, 'r2');
});

test('historical invoice and pay rates follow the effective date', () => {
  const emp = {
    id: 'emp_1', name: 'A', dailyWage: 24000, nightWage: 30000, payWage: 19000, payNightWage: 24000,
    wageHistory: [
      { from: '0000-01-01', dailyWage: 20000, nightWage: 25000, payWage: 16000, payNightWage: 20000 },
      { from: '2026-08-21', dailyWage: 24000, nightWage: 30000, payWage: 19000, payNightWage: 24000 },
    ],
  };
  assert.equal(core.ratesOn(emp, '2026-08-20').dailyWage, 20000);
  assert.equal(core.ratesOn(emp, '2026-08-21').dailyWage, 24000);
  assert.equal(core.payRates(emp, '2026-08-20').dailyWage, 16000);
  assert.equal(core.payRates(emp, '2026-08-21').dailyWage, 19000);
});

test('invoice and worker payment keep manual totals and transport rules separate', () => {
  const emp = { id: 'emp_1', dailyWage: 20000, nightWage: 25000, payWage: 16000, payNightWage: 20000 };
  const rec = { date: '2026-08-01', attendance: 1, overtimeHours: 2, nightAttendance: 1,
    nightOvertimeHours: 1, transportFee: 1000, transportToWorker: true };
  assert.equal(core.dailyTotal(rec, emp).total, 56156);
  assert.equal(core.payTotal(rec, emp).total, 45125);
  assert.equal(core.payTotal({ ...rec, transportToWorker: false }, emp).total, 44125);
  assert.equal(core.dailyTotal({ ...rec, manualTotal: 99999 }, emp).total, 99999);
  assert.equal(core.payTotal({ ...rec, manualTotal: 99999 }, emp).total, 45125);
});

test('10,000 deterministic money cases keep totals finite, integral and internally consistent', () => {
  const random = rng();
  const attendance = [0, 0.5, 1, 1.5, 2, 3];
  for (let i = 0; i < 10000; i++) {
    const emp = { dailyWage: 1 + Math.floor(random() * core.WAGE_MAX), nightWage: Math.floor(random() * core.WAGE_MAX) };
    const rec = { attendance: attendance[Math.floor(random() * attendance.length)], overtimeHours: Math.floor(random() * 97) / 4,
      nightAttendance: attendance[Math.floor(random() * attendance.length)], nightOvertimeHours: Math.floor(random() * 97) / 4,
      transportFee: Math.floor(random() * (core.INPUT_MAX.transportFee + 1)) };
    if (random() < 0.12) rec.manualTotal = 1 + Math.floor(random() * core.INPUT_MAX.manualTotal);
    const total = core.dailyTotal(rec, emp);
    for (const key of ['wage', 'ot', 'nwage', 'not', 'tr', 'autoTotal', 'total']) {
      assert.equal(Number.isFinite(total[key]), true, `case=${i}, key=${key}`);
      assert.equal(Number.isInteger(total[key]), true, `case=${i}, key=${key}`);
      assert.ok(total[key] >= 0, `case=${i}, key=${key}`);
    }
    assert.equal(total.autoTotal, total.wage + total.ot + total.nwage + total.not + total.tr);
    if (rec.attendance === 0) assert.equal(total.ot, 0);
    if (rec.nightAttendance === 0) assert.equal(total.not, 0);
  }
});

test('default transport applies on the first work transition without overwriting a value', () => {
  const rec = { attendance: 0, nightAttendance: 0, overtimeHours: 2, transportFee: 0 };
  assert.equal(core.shouldApplyDefaultTransport(rec, 'attendance', 1), true);
  assert.equal(core.shouldApplyDefaultTransport({ ...rec, transportFee: 500 }, 'attendance', 1), false);
  assert.equal(core.shouldApplyDefaultTransport({ ...rec, nightAttendance: 1 }, 'attendance', 1), false);
  assert.equal(core.shouldApplyDefaultTransport(rec, 'overtimeHours', 1), false);
});

test('A to B to A rate history still calculates each date independently', () => {
  const emp = { id: 'emp_1', name: 'A', dailyWage: 18000, nightWage: 0,
    wageHistory: [
      { from: '0000-01-01', dailyWage: 18000, nightWage: 0, payWage: 15000, payNightWage: 0 },
      { from: '2026-08-10', dailyWage: 20000, nightWage: 0, payWage: 17000, payNightWage: 0 },
      { from: '2026-08-20', dailyWage: 18000, nightWage: 0, payWage: 15000, payNightWage: 0 },
    ] };
  core.STATE.employees = [emp];
  core.STATE.records = ['2026-08-01', '2026-08-15', '2026-08-25'].map((date, i) =>
    ({ id: `r${i}`, employeeId: emp.id, date, attendance: 1, overtimeHours: 0,
      nightAttendance: 0, nightOvertimeHours: 0, transportFee: 0 }));
  core.invalidateIdx();
  assert.equal(core.periodReport(emp, '2026-08-01', '2026-08-31').grandTotal, 56000);
  assert.equal(core.payReport(emp, '2026-08-01', '2026-08-31').grandTotal, 47000);
});

test('replacing a rate from a period removes conflicting future entries only', { skip: !core.replaceWageHistoryFrom }, () => {
  const history = [
    { from: '0000-01-01', dailyWage: 18000, nightWage: 0, payWage: 15000, payNightWage: 0 },
    { from: '2026-07-21', dailyWage: 19000, nightWage: 0, payWage: 16000, payNightWage: 0 },
    { from: '2026-09-21', dailyWage: 21000, nightWage: 0, payWage: 18000, payNightWage: 0 },
  ];
  const out = core.replaceWageHistoryFrom(history, '2026-08-21', {
    dailyWage: 20000, nightWage: 0, payWage: 17000, payNightWage: 0,
  });
  assert.deepEqual(Array.from(out, x => x.from), ['0000-01-01', '2026-07-21', '2026-08-21']);
  assert.equal(out.at(-1).payWage, 17000);
});

test('new invoice numbers are unique annual sequences', { skip: !core.nextInvoiceNumber }, () => {
  const log = [
    { invoiceNo: '2026-000001' },
    { invoiceNo: '2026-08-001' },
    { invoiceNo: '2026-000003' },
    { invoiceNo: '2026-000003-取消' },
  ];
  assert.equal(core.nextInvoiceNumber(log, 2026), '2026-000004');
  assert.equal(core.nextInvoiceNumber(log, 2027), '2027-000001');
});

test('invoice printing waits for durable invoice-log storage', () => {
  const start = source.indexOf("$('pv-print').addEventListener");
  const end = source.indexOf('/* A4', start);
  assert.ok(start >= 0 && end > start, 'print handler not found');
  const handler = source.slice(start, end);
  assert.match(handler, /await saveInvoiceLog\(\)/);
  assert.ok(handler.indexOf('await saveInvoiceLog()') < handler.indexOf('window.print()'));
  assert.match(handler, /STATE\.invoiceLog\.(?:splice|pop)/);
});

test('backup validation preserves current payment and wage-history fields', { skip: !core.validateBackupPayload }, () => {
  const backup = {
    schemaVersion: core.BACKUP_SCHEMA_VERSION,
    employees: [{
      id: 'emp_1', name: 'A', dailyWage: 20000, nightWage: 25000,
      payWage: 16000, payNightWage: 20000, createdAt: '2026-01-01T00:00:00.000Z',
      wageHistory: [{ from: '0000-01-01', dailyWage: 18000, nightWage: 22000, payWage: 14000, payNightWage: 18000 }],
    }],
    records: [{
      id: 'rec_1', employeeId: 'emp_1', date: '2026-08-01', attendance: 1,
      overtimeHours: 0, nightAttendance: 0, nightOvertimeHours: 0,
      transportFee: 1000, transportToWorker: true,
    }],
    settings: {
      defaultTransportFee: 1000, taxRate: 10, closingDay: 31, monthlyGoal: 0,
      issuer: {}, client: {}, bank: {},
    },
    invoiceLog: [],
  };
  const out = core.validateBackupPayload(backup);
  assert.equal(out.employees[0].payWage, 16000);
  assert.equal(out.employees[0].payNightWage, 20000);
  assert.equal(out.employees[0].wageHistory[0].dailyWage, 18000);
  assert.equal(out.records[0].transportToWorker, true);
});

test('legacy 1.9.2 backup without schema version keeps current fields', () => {
  const legacy = {
    employees: [{ id: 'emp_1', name: 'A', dailyWage: 20000, nightWage: 25000,
      payWage: 16000, payNightWage: 20000,
      wageHistory: [{ from: '0000-01-01', dailyWage: 18000, nightWage: 22000, payWage: 14000, payNightWage: 18000 }] }],
    records: [{ id: 'r1', employeeId: 'emp_1', date: '2026-08-01', attendance: 1,
      overtimeHours: 0, nightAttendance: 0, nightOvertimeHours: 0, transportFee: 1000,
      transportToWorker: true }],
    settings: { defaultTransportFee: 1000, taxRate: 10, closingDay: 31, monthlyGoal: 0,
      issuer: {}, client: {}, bank: {} }, invoiceLog: [],
  };
  const out = core.validateBackupPayload(legacy);
  assert.equal(out.employees[0].payWage, 16000);
  assert.equal(out.employees[0].wageHistory[0].payNightWage, 18000);
  assert.equal(out.records[0].transportToWorker, true);
});

test('legacy backups preserve pre-cap evidence while schema backups reject new out-of-range data', () => {
  const legacy = {
    employees: [{ id: 'emp_1', name: 'A', dailyWage: 2000000, nightWage: 0 }],
    records: [{ id: 'r1', employeeId: 'emp_1', date: '2026-08-01', attendance: 1,
      overtimeHours: 100, nightAttendance: 0, nightOvertimeHours: 0,
      transportFee: 1000000, manualTotal: 50000000 }],
    settings: { defaultTransportFee: 1000000, taxRate: 10, closingDay: 31,
      monthlyGoal: 2000000000000, issuer: {}, client: {}, bank: {} }, invoiceLog: [],
  };
  const out = core.validateBackupPayload(legacy);
  assert.equal(out.employees[0].dailyWage, 2000000);
  assert.equal(out.records[0].overtimeHours, 100);
  assert.equal(out.records[0].manualTotal, 50000000);
  assert.equal(out.settings.defaultTransportFee, 1000000);
  const strict = structuredClone(legacy); strict.schemaVersion = core.BACKUP_SCHEMA_VERSION;
  assert.throws(() => core.validateBackupPayload(strict), /範囲外/);
});

test('legacy issued snapshots retain historical calculation evidence', () => {
  const settings = { defaultTransportFee: 1000, taxRate: 10, closingDay: 31, monthlyGoal: 0,
    issuer: { companyName: '発行者' }, client: { companyName: '取引先' }, bank: {} };
  const emp = { id: 'emp_1', name: 'A', dailyWage: 10000, nightWage: 0 };
  const historicalRecord = { id: 'old_r', employeeId: 'emp_1', date: '2026-08-01', attendance: 0,
    overtimeHours: 2, nightAttendance: 0, nightOvertimeHours: 0, transportFee: 1000 };
  const rep = { employeeId: 'emp_1', totalAttendance: 0, totalNightAttendance: 0,
    totalDailyWage: 0, totalOvertimePay: 3125, totalNightWage: 0,
    totalNightOvertimePay: 0, totalTransportFee: 1000, grandTotal: 4125, records: [historicalRecord] };
  const issue = { id: 'issue_1', issuedAt: '2026-08-02T00:00:00.000Z', invoiceNo: '2026-08-001',
    issueDate: '2026年8月2日', period: { start: '2026-08-01', end: '2026-08-31', label: '8月', periodLabel: '2026年8月分' },
    clientName: '取引先', issuerName: '発行者', subtotal: 4125, tax: 412, taxRate: 10, total: 4537,
    batch: false, voided: false, voidReason: '', snapshot: { settings, reports: [{ emp, rep }] } };
  const backup = { employees: [emp], records: [], settings, invoiceLog: [issue] };
  assert.doesNotThrow(() => core.validateBackupPayload(backup));
  backup.schemaVersion = core.BACKUP_SCHEMA_VERSION;
  assert.throws(() => core.validateBackupPayload(backup), /集計値が勤怠明細と一致/);
});

test('validated invoice snapshots and cancellation operator survive restore', () => {
  const settings = { defaultTransportFee: 1000, taxRate: 10, closingDay: 31, monthlyGoal: 0,
    issuer: { companyName: '発行者', postalCode: '', address: '', phone: '', invoiceNumber: 'T1234567890123' },
    client: { companyName: '取引先', postalCode: '', address: '', contactName: '' },
    bank: { bankName: '', branchName: '', accountType: '普通', accountNumber: '', accountHolder: '' } };
  const emp = { id: 'emp_1', name: 'A', dailyWage: 20000, nightWage: 0,
    payWage: 16000, payNightWage: 0, wageHistory: null, createdAt: '' };
  const record = { id: 'r1', employeeId: 'emp_1', date: '2026-08-01', attendance: 1,
    overtimeHours: 0, nightAttendance: 0, nightOvertimeHours: 0, transportFee: 1000,
    transportToWorker: true };
  const rep = { employeeId: 'emp_1', totalAttendance: 1, totalNightAttendance: 0,
    totalDailyWage: 20000, totalOvertimePay: 0, totalNightWage: 0,
    totalNightOvertimePay: 0, totalTransportFee: 1000, grandTotal: 21000, records: [record] };
  const period = { start: '2026-08-01', end: '2026-08-31', label: '8月', periodLabel: '2026年8月分' };
  const original = { id: 'issue_1', issuedAt: '2026-08-31T12:00:00.000Z', invoiceNo: '2026-000001',
    issueDate: '2026年8月31日', period, clientName: '取引先', issuerName: '発行者', subtotal: 21000,
    tax: 2100, taxRate: 10, total: 23100, batch: false, voided: false, voidReason: '',
    snapshot: { settings, reports: [{ emp, rep }] } };
  const cancellation = { id: 'issue_2', issuedAt: '2026-09-01T12:00:00.000Z', invoiceNo: '2026-000001-取消',
    issueDate: original.issueDate, period, clientName: '取引先', issuerName: '発行者', subtotal: -21000,
    tax: -2100, taxRate: 10, total: -23100, batch: false, voided: true, voidReason: '訂正',
    voidOperator: '担当者', voidedAt: '2026-09-01T12:00:00.000Z', voidOf: 'issue_1', snapshot: null };
  const out = core.validateBackupPayload({ schemaVersion: core.BACKUP_SCHEMA_VERSION,
    employees: [emp], records: [record], settings, invoiceLog: [original, cancellation] });
  assert.equal(out.invoiceLog[1].voidOperator, '担当者');
  const tampered = structuredClone({ schemaVersion: core.BACKUP_SCHEMA_VERSION,
    employees: [emp], records: [record], settings, invoiceLog: [original] });
  tampered.invoiceLog[0].total++;
  assert.throws(() => core.validateBackupPayload(tampered), /金額がスナップショットと一致/);
});

test('crafted IDs and duplicate days are rejected on restore', { skip: !core.validateBackupPayload }, () => {
  const base = {
    schemaVersion: core.BACKUP_SCHEMA_VERSION,
    employees: [{ id: 'emp_1', name: 'A', dailyWage: 20000, nightWage: 0, payWage: 0, payNightWage: 0, wageHistory: [] }],
    records: [{ id: 'r1', employeeId: 'emp_1', date: '2026-08-01', attendance: 1, overtimeHours: 0, nightAttendance: 0, nightOvertimeHours: 0, transportFee: 0 }],
    settings: { defaultTransportFee: 1000, taxRate: 10, closingDay: 31, monthlyGoal: 0, issuer: {}, client: {}, bank: {} },
    invoiceLog: [],
  };
  const unsafe = structuredClone(base);
  unsafe.employees[0].id = "x');alert(1)//";
  unsafe.records[0].employeeId = unsafe.employees[0].id;
  assert.throws(() => core.validateBackupPayload(unsafe), /IDが不正/);
  const duplicate = structuredClone(base);
  duplicate.records.push({ ...duplicate.records[0], id: 'r2' });
  assert.throws(() => core.validateBackupPayload(duplicate), /重複/);
});

test('backup validation handles 10,000 attendance rows', () => {
  const employees = [], records = [];
  for (let e = 0; e < 100; e++) {
    const employeeId = `emp_${e}`;
    employees.push({ id: employeeId, name: `E${e}`, dailyWage: 10000 + e, nightWage: 0 });
    for (let d = 0; d < 100; d++) {
      const day = new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
      records.push({ id: `r_${e}_${d}`, employeeId, date: day, attendance: 1,
        overtimeHours: d % 3, nightAttendance: 0, nightOvertimeHours: 0, transportFee: 1000 });
    }
  }
  const out = core.validateBackupPayload({ employees, records,
    settings: { defaultTransportFee: 1000, taxRate: 10, closingDay: 31, monthlyGoal: 0,
      issuer: {}, client: {}, bank: {} }, invoiceLog: [] });
  assert.equal(out.records.length, 10000);
});

test('restore is atomic and app-owned caches are scoped', () => {
  const restore = source.slice(source.indexOf("$('import-btn').addEventListener"), source.indexOf("$('reset-btn')"));
  assert.match(restore, /validateBackupPayload/);
  assert.match(restore, /await idbSetMany/);
  assert.ok(restore.indexOf('await idbSetMany') < restore.indexOf('STATE.employees='));
  assert.match(source, /ks\.filter\(k=>k\.startsWith\('invoice-'\)\)/);
  assert.doesNotMatch(source, /getRegistrations\(\)/);
  assert.match(swSource, /k\.startsWith\('invoice-'\)&&k!==CACHE/);
});

test('version, cache and automatic-report disclosure are updated together', () => {
  assert.match(source, /const APP_VERSION='1\.18\.0'/);
  assert.match(swSource, /const CACHE='invoice-v31'/);
  assert.match(htmlSource, /利用状況だけが自動送信/);
  assert.doesNotMatch(htmlSource, /勝手に送られることはありません/);
  assert.match(source, /const printSeal=.*cssMode==='print'/);
  assert.match(htmlSource, /法定保存を補助する機能/);
});
