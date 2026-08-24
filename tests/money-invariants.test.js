'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCore() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const cut = source.indexOf('/* ---------- BOOT ---------- */');
  assert.notEqual(cut, -1);
  const context = {
    console, Date, Math, JSON, Map, Set, String, Number, Array, Object, Intl, Promise,
    setTimeout, clearTimeout,
    // 利用ログの自動保存が module scope で setInterval を呼ぶ。検査では動かさない
    setInterval: () => 0, clearInterval: () => {}, addEventListener: () => {},
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
  vm.runInContext(source.slice(0, cut) + `\n;globalThis.__moneyCore={dailyTotal,periodReport,STATE,invalidateIdx,INPUT_MAX,WAGE_MAX};`, context, { filename: 'app-money-core.js' });
  return context.__moneyCore;
}

const core = loadCore();

// 再現可能な xorshift32。失敗したとき同じ seed で必ず再現できる。
function rng(seed = 0x51a7c0de) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

function pick(r, values) { return values[Math.floor(r() * values.length)]; }
function int(r, max) { return Math.floor(r() * (max + 1)); }

test('money invariants: 10000件の日計で内訳・上限・休み条件が崩れない', () => {
  const r = rng();
  const attendanceValues = [0, 0.5, 1, 1.5, 2, 3];
  for (let i = 0; i < 10000; i++) {
    const emp = {
      dailyWage: 1 + int(r, core.WAGE_MAX - 1),
      nightWage: int(r, core.WAGE_MAX),
    };
    const rec = {
      attendance: pick(r, attendanceValues),
      overtimeHours: int(r, core.INPUT_MAX.overtimeHours * 4) / 4,
      nightAttendance: pick(r, attendanceValues),
      nightOvertimeHours: int(r, core.INPUT_MAX.nightOvertimeHours * 4) / 4,
      transportFee: int(r, core.INPUT_MAX.transportFee),
    };
    if (r() < 0.12) rec.manualTotal = 1 + int(r, core.INPUT_MAX.manualTotal - 1);

    const t = core.dailyTotal(rec, emp);
    for (const key of ['wage','ot','nwage','not','tr','autoTotal','total']) {
      assert.equal(Number.isFinite(t[key]), true, `case=${i} ${key} is not finite`);
      assert.equal(Number.isInteger(t[key]), true, `case=${i} ${key} is not integer`);
      assert.ok(t[key] >= 0, `case=${i} ${key} is negative`);
    }
    assert.equal(t.autoTotal, t.wage + t.ot + t.nwage + t.not + t.tr, `case=${i} autoTotal mismatch`);
    assert.equal(t.total, t.overridden ? Math.round(rec.manualTotal) : t.autoTotal, `case=${i} total mismatch`);
    if (rec.attendance === 0) assert.equal(t.ot, 0, `case=${i} day overtime billed while absent`);
    if (rec.nightAttendance === 0) assert.equal(t.not, 0, `case=${i} night overtime billed while absent`);
  }
});

test('money invariants: 365日分の期間合計は各日の確定合計と一致する', () => {
  const r = rng(0x20260819);
  const emp = { id: 'inv_emp', name: 'Invariant', dailyWage: 17300, nightWage: 21500 };
  const records = [];
  let expected = 0;
  const start = new Date(2026, 0, 1);
  for (let i = 0; i < 365; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const rec = {
      id: `inv_${i}`,
      employeeId: emp.id,
      date,
      attendance: r() < 0.72 ? 1 : 0,
      overtimeHours: int(r, 12) / 2,
      nightAttendance: r() < 0.18 ? 1 : 0,
      nightOvertimeHours: int(r, 8) / 2,
      transportFee: r() < 0.7 ? 1000 : 0,
    };
    if (r() < 0.05) rec.manualTotal = 10000 + int(r, 25000);
    records.push(rec);
    expected += core.dailyTotal(rec, emp).total;
  }
  core.STATE.employees = [emp];
  core.STATE.records = records;
  core.invalidateIdx();
  const report = core.periodReport(emp, '2026-01-01', '2026-12-31');
  assert.equal(report.grandTotal, expected);
  assert.equal(report.records.length, 365);
});
