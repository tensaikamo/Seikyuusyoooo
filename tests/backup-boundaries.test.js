'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadValidator() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const cut = source.indexOf('/* ---------- BOOT ---------- */');
  assert.notEqual(cut, -1);
  // 利用ログの自動保存が module scope で setInterval を呼ぶ。検査では動かさない
  const context = { console, Date, Math, JSON, Map, Set, String, Number, Array, Object, Intl, Promise,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, addEventListener: () => {} };
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
  vm.runInContext(source.slice(0, cut) + '\n;globalThis.__validator={validateBackupPayload};', context, { filename: 'app-backup-core.js' });
  return context.__validator.validateBackupPayload;
}

const validate = loadValidator();
const settings = { defaultTransportFee: 1000, taxRate: 10, closingDay: 31, monthlyGoal: 0, issuer: {}, client: {}, bank: {} };

function isoDay(offset) {
  const d = new Date(2026, 0, 1);
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

test('backup scale: 有効な勤怠10000件を全件検証できる', () => {
  const employees = [];
  const records = [];
  for (let e = 0; e < 100; e++) {
    const employeeId = `emp_${e}`;
    employees.push({ id: employeeId, name: `従業員${e}`, dailyWage: 10000 + e, nightWage: 0, createdAt: '2026-01-01T00:00:00.000Z' });
    for (let d = 0; d < 100; d++) {
      records.push({
        id: `rec_${e}_${d}`, employeeId, date: isoDay(d),
        attendance: 1, overtimeHours: d % 3, nightAttendance: 0,
        nightOvertimeHours: 0, transportFee: 1000,
      });
    }
  }
  const out = validate({ employees, records, settings, invoiceLog: [] });
  assert.equal(out.employees.length, 100);
  assert.equal(out.records.length, 10000);
});

test('backup scale: トップレベル件数の安全上限を超えたデータは処理前に拒否する', () => {
  assert.throws(() => validate({ employees: new Array(5001).fill(null), records: [], settings, invoiceLog: [] }), /件数が上限/);
  assert.throws(() => validate({ employees: [], records: new Array(500001).fill(null), settings, invoiceLog: [] }), /件数が上限/);
  assert.throws(() => validate({ employees: [], records: [], settings, invoiceLog: new Array(100001).fill(null) }), /件数が上限/);
});

test('backup scale: 1発行履歴内のsnapshot明細上限を超えたら拒否する', () => {
  const issue = {
    id: 'issue_big', issuedAt: '2026-08-02T00:00:00.000Z', invoiceNo: '2026-000001', issueDate: '2026年8月2日',
    period: { start: '2026-08-01', end: '2026-08-31', label: '2026年8月1日〜2026年8月31日', periodLabel: '2026年8月分' },
    clientName: '取引先', issuerName: '発行者', subtotal: 0, tax: 0, taxRate: 10, total: 0,
    batch: false, voided: false, voidReason: '',
    snapshot: { settings, reports: new Array(5001).fill({}) },
  };
  assert.throws(() => validate({ employees: [], records: [], settings, invoiceLog: [issue] }), /明細件数が多すぎ|形式が不正/);
});
