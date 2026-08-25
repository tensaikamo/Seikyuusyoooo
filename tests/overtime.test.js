'use strict';

/*
 * 労働基準法「時間外労働の集計」の仕様テスト（実装より先に書いたもの）。
 *
 * 対象: overtimeBreakdown(employeeId, startDate, endDate)
 *   -> { daily:  [{date, workedHours, dailyOver, weeklyOver, holidayHours}],
 *        weekly: [{weekStart, weekEnd, workedHours, legalOver}],
 *        months: [{label, start, end, overtime, withHoliday, exceeds45, exceeds100}],
 *        totals: {overtime, withHoliday, months45Count} }
 *
 *   overtime    … 法定時間外（法定休日労働を含まない）
 *   withHoliday … 法定時間外 ＋ 法定休日労働
 *
 * 実装はまだ存在しない。全件失敗するのが正しい状態。
 * 実装後は app.js の BOOT マーカーより前に overtimeBreakdown を定義すれば結線される。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* ------------------------------------------------------------------ *
 * ローダー（tests/core-invariants.test.js と同じ手法）
 * ------------------------------------------------------------------ */
const APP_PATH = path.join(__dirname, '..', 'app.js');

function loadSpec() {
  const source = fs.readFileSync(APP_PATH, 'utf8');
  const bootMarker = '/* ---------- BOOT ---------- */';
  const cut = source.indexOf(bootMarker);
  assert.notEqual(cut, -1, 'app.js の BOOT マーカーが見つからない');
  const prefix = source.slice(0, cut);

  // 未実装でも読み込み自体は成功させ、テストを1件ずつ失敗させる
  // （ReferenceError でファイルごと落とすと、どの規則が未達か分からなくなる）
  const expose = `\n;globalThis.__spec = {
    overtimeBreakdown: (typeof overtimeBreakdown === 'function') ? overtimeBreakdown : null,
    STATE: (typeof STATE !== 'undefined') ? STATE : null,
    invalidateIdx: (typeof invalidateIdx === 'function') ? invalidateIdx : function(){}
  };`;

  const context = {
    console, Date, Math, JSON, Map, Set, String, Number, Array, Object, Intl, Promise,
    setTimeout, clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener: () => {},
  };
  context.globalThis = context;
  context.window = context;
  context.self = context;
  context.addEventListener = () => {};
  context.removeEventListener = () => {};
  context.matchMedia = () => ({ matches: false, addEventListener: () => {} });
  context.document = {
    addEventListener: () => {}, getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [], documentElement: {}, body: {},
  };
  context.navigator = { userAgent: 'test', storage: {} };
  context.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  context.indexedDB = { open: () => ({}) };
  context.screen = { width: 390, height: 844 };
  vm.createContext(context);
  vm.runInContext(prefix + expose, context, { filename: 'app-core.js' });
  return context.__spec;
}

const spec = loadSpec();
const BASE_SETTINGS = spec && spec.STATE
  ? JSON.parse(JSON.stringify(spec.STATE.settings))
  : { closingDay: 31, workHours: 8 };

/** 未実装なら「未実装である」と分かる形で落とす */
function overtimeBreakdown(employeeId, startDate, endDate) {
  assert.ok(
    spec && typeof spec.overtimeBreakdown === 'function',
    'overtimeBreakdown が未実装。app.js の BOOT マーカーより前に定義すること'
  );
  return spec.overtimeBreakdown(employeeId, startDate, endDate);
}

/* ------------------------------------------------------------------ *
 * データ組み立てのヘルパー
 * ------------------------------------------------------------------ */
const EMP_ID = 'emp_ot';
const OTHER_ID = 'emp_other';

function emp(id, name) {
  return { id, name, dailyWage: 16000, nightWage: 18000, createdAt: '2026-01-01T00:00:00.000Z' };
}

/** attendance は 0 / 0.5 / 1 のみ。overtimeHours は所定を超えた分の手入力 */
function rec(employeeId, date, attendance, overtimeHours, extra) {
  return Object.assign({
    id: `${employeeId}_${date}`,
    employeeId,
    date,
    attendance,
    overtimeHours: overtimeHours || 0,
    nightAttendance: 0,
    nightOvertimeHours: 0,
    transportFee: 0,
  }, extra || {});
}

function setup(records, settingsOverride) {
  assert.ok(spec && spec.STATE, 'app.js の STATE を取得できない');
  spec.STATE.employees = [emp(EMP_ID, '対象者'), emp(OTHER_ID, '別人')];
  spec.STATE.records = records;
  spec.STATE.settings = Object.assign(
    JSON.parse(JSON.stringify(BASE_SETTINGS)),
    { closingDay: 31, workHours: 8 },
    settingsOverride || {}
  );
  spec.invalidateIdx();
}

function iso(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function parse(s) { return new Date(s + 'T00:00:00Z'); }
function dow(s) { return parse(s).getUTCDay(); }         // 0=日
function addDays(s, n) { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); }

/** from..to（両端含む）の日付を並べる */
function days(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 年月の平日（月〜金）を並べる */
function weekdaysIn(year, month) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const out = [];
  for (let d = 1; d <= last; d++) {
    const s = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const w = dow(s);
    if (w >= 1 && w <= 5) out.push(s);
  }
  return out;
}

/**
 * 平日だけに残業を割り振り、その月の法定時間外をちょうど target にする。
 * 週の労働日が5日以内なので週40時間超は発生せず、日8時間超だけが残る。
 */
function assignMonthlyOvertime(records, employeeId, year, month, target) {
  const wds = weekdaysIn(year, month);
  let remaining = target, i = 0;
  while (remaining > 1e-9) {
    assert.ok(i < wds.length, 'テストデータの割り振りに平日が足りない');
    const h = Math.min(4, remaining);
    records.push(rec(employeeId, wds[i], 1, h));
    remaining -= h;
    i++;
  }
  return records;
}

const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const near = (a, b) => Math.abs(a - b) < 1e-9;

/* ------------------------------------------------------------------ *
 * 共通の不変条件チェック
 * ------------------------------------------------------------------ */
function checkNumber(v, where) {
  assert.equal(typeof v, 'number', `${where}: 数値でない (${JSON.stringify(v)})`);
  assert.ok(Number.isFinite(v), `${where}: NaN/Infinity になっている (${v})`);
  assert.ok(v >= -1e-9, `${where}: 負の時間が出ている (${v})`);
}

/** halfGrid=true のとき、所定8h・入力が0.5刻みなので結果も0.5刻みでなければならない */
function checkInvariants(res, opts) {
  const o = opts || {};
  assert.ok(res && typeof res === 'object', '戻り値がオブジェクトでない');
  assert.ok(Array.isArray(res.daily), 'daily が配列でない');
  assert.ok(Array.isArray(res.weekly), 'weekly が配列でない');
  assert.ok(Array.isArray(res.months), 'months が配列でない');
  assert.ok(res.totals && typeof res.totals === 'object', 'totals が無い');

  const halfGrid = (v, where) => {
    if (!o.halfGrid) return;
    assert.ok(near(v * 2, Math.round(v * 2)), `${where}: 0.5刻みから外れている (${v})`);
  };

  const seen = new Set();
  let prev = '';
  res.daily.forEach((d, i) => {
    ['workedHours', 'dailyOver', 'weeklyOver', 'holidayHours'].forEach(k => {
      checkNumber(d[k], `daily[${i}].${k} (${d.date})`);
      halfGrid(d[k], `daily[${i}].${k} (${d.date})`);
    });
    assert.match(String(d.date), /^\d{4}-\d{2}-\d{2}$/, `daily[${i}].date の形式が不正`);
    assert.ok(!seen.has(d.date), `daily に同じ日付が2件ある: ${d.date}`);
    seen.add(d.date);
    assert.ok(d.date >= prev, 'daily が日付昇順でない');
    prev = d.date;
    if (o.range) {
      assert.ok(d.date >= o.range[0] && d.date <= o.range[1],
        `daily に範囲外の日が混ざっている: ${d.date}`);
    }
    // 法定休日の労働は時間外として二重に数えない
    assert.ok(d.holidayHours <= d.workedHours + 1e-9,
      `daily[${i}]: 休日労働が実労働時間を超えている (${d.date})`);
    assert.ok(d.dailyOver + d.weeklyOver + d.holidayHours <= d.workedHours + 1e-9,
      `daily[${i}]: 時間外＋休日労働が実労働時間を超えている (${d.date})`);
  });

  res.weekly.forEach((w, i) => {
    ['workedHours', 'legalOver'].forEach(k => {
      checkNumber(w[k], `weekly[${i}].${k}`);
      halfGrid(w[k], `weekly[${i}].${k}`);
    });
    assert.match(String(w.weekStart), /^\d{4}-\d{2}-\d{2}$/, `weekly[${i}].weekStart の形式が不正`);
    assert.match(String(w.weekEnd), /^\d{4}-\d{2}-\d{2}$/, `weekly[${i}].weekEnd の形式が不正`);
    assert.ok(w.weekStart <= w.weekEnd, `weekly[${i}]: 週の開始が終了より後`);
  });

  res.months.forEach((m, i) => {
    ['overtime', 'withHoliday'].forEach(k => {
      checkNumber(m[k], `months[${i}].${k}`);
      halfGrid(m[k], `months[${i}].${k}`);
    });
    assert.equal(typeof m.label, 'string', `months[${i}].label が文字列でない`);
    assert.ok(m.label.length > 0, `months[${i}].label が空`);
    assert.match(String(m.start), /^\d{4}-\d{2}-\d{2}$/, `months[${i}].start の形式が不正`);
    assert.match(String(m.end), /^\d{4}-\d{2}-\d{2}$/, `months[${i}].end の形式が不正`);
    assert.ok(m.start <= m.end, `months[${i}]: 開始が終了より後`);
    assert.equal(typeof m.exceeds45, 'boolean', `months[${i}].exceeds45 が真偽値でない`);
    assert.equal(typeof m.exceeds100, 'boolean', `months[${i}].exceeds100 が真偽値でない`);
    // 休日労働込みが時間外のみを下回ることはない
    assert.ok(m.withHoliday >= m.overtime - 1e-9,
      `months[${i}]: withHoliday(${m.withHoliday}) < overtime(${m.overtime})`);
    // 上限の基準の取り違え（45は休日を含まない／100は休日を含む）
    assert.equal(m.exceeds45, m.overtime > 45 + 1e-9,
      `months[${i}] ${m.label}: 月45時間の判定は休日労働を含まない overtime(${m.overtime}) で行う`);
    assert.equal(m.exceeds100, m.withHoliday >= 100 - 1e-9,
      `months[${i}] ${m.label}: 単月100時間「未満」の判定は休日労働を含む withHoliday(${m.withHoliday}) で行う`);
    if (i > 0) {
      assert.equal(m.start, addDays(res.months[i - 1].end, 1),
        `months: 月の区切りに隙間か重複がある (${res.months[i - 1].end} → ${m.start})`);
    }
  });

  ['overtime', 'withHoliday', 'months45Count'].forEach(k => {
    checkNumber(res.totals[k], `totals.${k}`);
  });
  assert.ok(res.totals.withHoliday >= res.totals.overtime - 1e-9,
    `totals: withHoliday(${res.totals.withHoliday}) < overtime(${res.totals.overtime})`);

  // 日ごとの合計 == 月の合計 == totals
  const dailyOt = sum(res.daily, d => d.dailyOver + d.weeklyOver);
  const dailyHol = sum(res.daily, d => d.holidayHours);
  assert.ok(near(dailyOt, res.totals.overtime),
    `日ごとの時間外の合計(${dailyOt}) と totals.overtime(${res.totals.overtime}) が一致しない`);
  assert.ok(near(dailyOt + dailyHol, res.totals.withHoliday),
    `日ごとの時間外＋休日労働(${dailyOt + dailyHol}) と totals.withHoliday(${res.totals.withHoliday}) が一致しない`);
  assert.ok(near(sum(res.months, m => m.overtime), res.totals.overtime),
    '月ごとの overtime の合計が totals.overtime と一致しない');
  assert.ok(near(sum(res.months, m => m.withHoliday), res.totals.withHoliday),
    '月ごとの withHoliday の合計が totals.withHoliday と一致しない');
  assert.ok(near(sum(res.weekly, w => w.legalOver), res.totals.overtime),
    '週ごとの legalOver の合計が totals.overtime と一致しない');
  assert.ok(near(sum(res.weekly, w => w.workedHours), sum(res.daily, d => d.workedHours)),
    '週ごとの workedHours の合計が日ごとの合計と一致しない');
  assert.equal(res.totals.months45Count, res.months.filter(m => m.exceeds45).length,
    'totals.months45Count が exceeds45 の月数と一致しない');

  // 出勤が0の日は時間外も0
  res.daily.forEach(d => {
    if (near(d.workedHours, 0)) {
      assert.ok(near(d.dailyOver, 0) && near(d.weeklyOver, 0) && near(d.holidayHours, 0),
        `出勤0の日に時間外が付いている: ${d.date}`);
    }
  });
  return res;
}

/** 指定日の daily 行 */
function day(res, date) {
  const d = res.daily.find(x => x.date === date);
  assert.ok(d, `daily に ${date} が無い`);
  return d;
}
/** 指定の起算日で始まる週 */
function weekOf(res, weekStart) {
  const w = res.weekly.find(x => x.weekStart === weekStart);
  assert.ok(w, `weekly に ${weekStart} 始まりの週が無い（週の起算日が日曜になっていない可能性）`);
  return w;
}

/* ================================================================== *
 * 1. 法定時間外の数え方（日8時間超 → 週40時間超。二重カウント禁止）
 * ================================================================== */

test('日8時間超が先。月〜金 毎日9時間は 5時間（10時間ではない）', () => {
  // 2026-08-02(日) 起算の週。月3日〜金7日を 1人工＋残業1h ＝ 9時間
  const records = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']
    .map(d => rec(EMP_ID, d, 1, 1));
  setup(records);
  const res = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');
  checkInvariants(res, { range: ['2026-08-02', '2026-08-08'], halfGrid: true });

  assert.equal(res.totals.overtime, 5,
    '週45時間から日8時間超の5時間を引かずに二重計上している（週40時間超の5時間を足して10にしていないか）');
  assert.equal(sum(res.daily, d => d.dailyOver), 5, '日8時間超が5時間にならない');
  assert.equal(sum(res.daily, d => d.weeklyOver), 0,
    '日8時間超で数えた分を、週40時間超でもう一度数えている');
  assert.equal(res.weekly.length, 1, '週が1つにまとまっていない');
  assert.equal(res.weekly[0].workedHours, 45, '週の実労働が45時間にならない');
  assert.equal(res.weekly[0].legalOver, 5, '週の法定時間外が5時間にならない');
});

test('週40時間超は残業hの入力が0でも発生する。週6日×1人工は 8時間', () => {
  const records = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08']
    .map(d => rec(EMP_ID, d, 1, 0));
  setup(records);
  const res = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');
  checkInvariants(res, { range: ['2026-08-02', '2026-08-08'], halfGrid: true });

  assert.equal(res.totals.overtime, 8,
    '残業hの手入力だけを合計していて、週48時間から法定40時間を超えた8時間を拾えていない');
  assert.equal(sum(res.daily, d => d.dailyOver), 0, '9時間働いていないのに日8時間超が出ている');
  assert.equal(sum(res.daily, d => d.weeklyOver), 8, '週40時間超が8時間にならない');
  assert.equal(res.weekly[0].legalOver, 8);
});

test('週5日×1人工（週ちょうど40時間）は 0時間', () => {
  const records = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']
    .map(d => rec(EMP_ID, d, 1, 0));
  setup(records);
  const res = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');
  checkInvariants(res, { range: ['2026-08-02', '2026-08-08'], halfGrid: true });

  assert.equal(res.weekly[0].workedHours, 40);
  assert.equal(res.totals.overtime, 0, 'ちょうど40時間は「超」ではないので時間外は発生しない');
  assert.equal(res.totals.withHoliday, 0);
});

test('週40時間超は、週の途中で40時間を超えた日に付く（月への割り振りの土台）', () => {
  // 月〜土 6日×8時間。金曜終了時点で40時間、土曜の8時間が超過分
  const wd = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08'];
  setup(wd.map(d => rec(EMP_ID, d, 1, 0)));
  const res = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');
  checkInvariants(res, { range: ['2026-08-02', '2026-08-08'], halfGrid: true });

  wd.slice(0, 5).forEach(d => {
    assert.equal(day(res, d).weeklyOver, 0, `${d}: 週40時間に達する前の日に超過が付いている`);
  });
  assert.equal(day(res, '2026-08-08').weeklyOver, 8,
    '週40時間超が、超えた日に割り当てられていない（月をまたぐ週の割り振りができなくなる）');
});

/* ---- 0.5人工 ---- */

test('0.5人工は4時間。残業3時間を足しても7時間なので法定時間外は0', () => {
  // 0.5人工(4h)+残業3h=7h。残業hの手入力をそのまま法定時間外にすると誤って3時間になる
  const records = [
    rec(EMP_ID, '2026-08-03', 1, 0),
    rec(EMP_ID, '2026-08-04', 1, 0),
    rec(EMP_ID, '2026-08-05', 1, 0),
    rec(EMP_ID, '2026-08-06', 1, 0),
    rec(EMP_ID, '2026-08-07', 0.5, 3),
  ];
  setup(records);
  const res = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');
  checkInvariants(res, { range: ['2026-08-02', '2026-08-08'], halfGrid: true });

  assert.equal(day(res, '2026-08-07').workedHours, 7, '0.5人工＋残業3hが7時間になっていない');
  assert.equal(day(res, '2026-08-07').dailyOver, 0,
    '残業hの手入力をそのまま法定時間外にしている（法定時間外は1日8時間を超えた分だけ）');
  assert.equal(res.weekly[0].workedHours, 39);
  assert.equal(res.totals.overtime, 0, '週39時間なので時間外は発生しない');
});

test('0.5人工＋残業5時間は9時間なので日8時間超が1時間', () => {
  setup([rec(EMP_ID, '2026-08-03', 0.5, 5)]);
  const res = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');
  checkInvariants(res, { range: ['2026-08-02', '2026-08-08'], halfGrid: true });
  assert.equal(day(res, '2026-08-03').workedHours, 9);
  assert.equal(day(res, '2026-08-03').dailyOver, 1);
  assert.equal(res.totals.overtime, 1);
});

test('0.5人工が混ざる週：週44時間で 4時間（人工数ではなく時間で数える）', () => {
  const records = [
    rec(EMP_ID, '2026-08-03', 1, 0),
    rec(EMP_ID, '2026-08-04', 1, 0),
    rec(EMP_ID, '2026-08-05', 1, 0),
    rec(EMP_ID, '2026-08-06', 1, 0),
    rec(EMP_ID, '2026-08-07', 1, 0),
    rec(EMP_ID, '2026-08-08', 0.5, 0),
  ];
  setup(records);
  const res = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');
  checkInvariants(res, { range: ['2026-08-02', '2026-08-08'], halfGrid: true });

  assert.equal(res.weekly[0].workedHours, 44, '0.5人工を4時間として数えていない');
  assert.equal(res.totals.overtime, 4,
    '週6日を出勤日数で判定していないか（時間で数えれば44時間で超過は4時間）');
  assert.equal(day(res, '2026-08-08').weeklyOver, 4);
});

test('0.5人工だけの週は法定時間外0（0.5刻みが崩れない）', () => {
  const records = days('2026-08-03', '2026-08-08').map(d => rec(EMP_ID, d, 0.5, 0.5));
  setup(records);
  const res = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');
  checkInvariants(res, { range: ['2026-08-02', '2026-08-08'], halfGrid: true });
  assert.equal(res.weekly[0].workedHours, 27, '4.5時間×6日で27時間にならない');
  assert.equal(res.totals.overtime, 0);
});

/* ---- 所定労働時間の設定と、法定8時間の区別 ---- */

test('所定7.5時間でも法定時間外の基準は8時間（法内残業を法定時間外に混ぜない）', () => {
  // 所定7.5h + 残業0.5h = 8.0h → 法内残業。法定時間外は0
  const records = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']
    .map(d => rec(EMP_ID, d, 1, 0.5));
  setup(records, { workHours: 7.5 });
  const res = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');
  checkInvariants(res, { range: ['2026-08-02', '2026-08-08'] });

  assert.equal(day(res, '2026-08-03').workedHours, 8, '1人工が所定7.5時間で計算されていない');
  assert.equal(res.totals.overtime, 0,
    '所定7.5時間を超えた分を法定時間外にしている（法定は8時間。7.5〜8.0は法内残業）');

  // 所定7.5h + 残業1.5h = 9.0h → 法定時間外は1時間
  setup([rec(EMP_ID, '2026-08-03', 1, 1.5)], { workHours: 7.5 });
  const res2 = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');
  checkInvariants(res2, { range: ['2026-08-02', '2026-08-08'] });
  assert.equal(res2.totals.overtime, 1, '9時間働いた日の法定時間外が1時間にならない');
});

test('所定7.5時間・週6日は週45時間で 5時間（週の基準も法定40時間のまま）', () => {
  const records = days('2026-08-03', '2026-08-08').map(d => rec(EMP_ID, d, 1, 0));
  setup(records, { workHours: 7.5 });
  const res = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');
  checkInvariants(res, { range: ['2026-08-02', '2026-08-08'] });
  assert.equal(res.weekly[0].workedHours, 45);
  assert.equal(res.totals.overtime, 5, '週の基準が所定×日数になっている（法定は40時間）');
});

/* ================================================================== *
 * 2. 週の起算日
 * ================================================================== */

test('週の起算は既定で日曜（日〜土）。日〜金の6日48時間は 8時間', () => {
  const records = days('2026-08-23', '2026-08-28').map(d => rec(EMP_ID, d, 1, 0)); // 日〜金
  setup(records);
  const res = overtimeBreakdown(EMP_ID, '2026-08-23', '2026-08-29');
  checkInvariants(res, { range: ['2026-08-23', '2026-08-29'], halfGrid: true });

  assert.equal(res.weekly.length, 1, '日〜土が1つの週にまとまっていない');
  assert.equal(dow(res.weekly[0].weekStart), 0, 'weekStart が日曜でない');
  assert.equal(res.weekly[0].weekEnd, addDays(res.weekly[0].weekStart, 6), '週が7日間でない');
  assert.equal(res.totals.overtime, 8);
});

test('週の起算日は設定で変えられる。月曜起算にすると同じ勤怠でも 0時間になる', () => {
  // 日8/23〜金8/28 の6日。日曜起算なら1週48時間で8時間、月曜起算なら 8h + 40h に割れて0時間
  const records = days('2026-08-23', '2026-08-28').map(d => rec(EMP_ID, d, 1, 0));
  // 要確認: 設定キー名が未定のため、あり得る名前をまとめて指定している
  setup(records, { weekStartDow: 1 });
  const res = overtimeBreakdown(EMP_ID, '2026-08-17', '2026-08-30');
  checkInvariants(res, { range: ['2026-08-17', '2026-08-30'] });

  assert.equal(res.totals.overtime, 0,
    '週の起算日の設定を見ていない（月曜起算なら日曜の8時間は前の週に入り、月〜金は40時間ちょうど）');
});

/* ================================================================== *
 * 3. 月の区切り（暦月と締め日基準）
 * ================================================================== */

test('暦月：週が月をまたぐとき、時間外は発生した日の月に入る', () => {
  // 8/30(日)〜9/4(金) の6日×8時間。40時間を超えるのは9/4なので、8月0時間・9月8時間
  const records = days('2026-08-30', '2026-09-04').map(d => rec(EMP_ID, d, 1, 0));
  setup(records, { closingDay: 31 });
  const res = overtimeBreakdown(EMP_ID, '2026-08-01', '2026-09-30');
  checkInvariants(res, { range: ['2026-08-01', '2026-09-30'], halfGrid: true });

  assert.equal(res.months.length, 2, '暦月で8月・9月の2区間にならない');
  assert.equal(res.months[0].start, '2026-08-01');
  assert.equal(res.months[0].end, '2026-08-31', '月末締めの区切りが暦月末になっていない');
  assert.equal(res.months[1].start, '2026-09-01');
  assert.equal(res.months[1].end, '2026-09-30');

  assert.equal(res.totals.overtime, 8, '月をまたぐ週の法定時間外が8時間にならない');
  assert.equal(res.months[0].overtime, 0,
    '週の超過を週の始まる月へまとめて寄せている（超過が発生したのは9/4）');
  assert.equal(res.months[1].overtime, 8, '週の超過が、超過の発生した日の月に入っていない');
  assert.equal(weekOf(res, '2026-08-30').legalOver, 8,
    '週の合計としては8時間でなければならない');
});

test('締め日20日：月をまたぐ週で、日8時間超と週40時間超が別の月に分かれる', () => {
  // 8/16(日)〜8/20(木) は 1人工＋残業2h（日8時間超が各2h＝10h、締め7/21〜8/20側）
  // 8/21(金) は 1人工。週の基本8h×6日=48hのうち40時間を超えるのは8/21の8h（締め8/21〜9/20側）
  const records = days('2026-08-16', '2026-08-20').map(d => rec(EMP_ID, d, 1, 2));
  records.push(rec(EMP_ID, '2026-08-21', 1, 0));
  setup(records, { closingDay: 20 });
  const res = overtimeBreakdown(EMP_ID, '2026-07-21', '2026-09-20');
  checkInvariants(res, { range: ['2026-07-21', '2026-09-20'], halfGrid: true });

  assert.equal(res.months.length, 2, '締め日20日で2区間にならない');
  assert.equal(res.months[0].start, '2026-07-21', '20日締めの開始が前月21日でない');
  assert.equal(res.months[0].end, '2026-08-20', '20日締めの終了が当月20日でない');
  assert.equal(res.months[1].start, '2026-08-21');
  assert.equal(res.months[1].end, '2026-09-20');

  assert.equal(res.totals.overtime, 18, '週の法定時間外が 10（日超）＋8（週超）＝18 にならない');
  assert.equal(res.months[0].overtime, 10, '日8時間超10時間が締め期間 7/21〜8/20 に入っていない');
  assert.equal(res.months[1].overtime, 8, '週40時間超8時間が締め期間 8/21〜9/20 に入っていない');
  assert.equal(weekOf(res, '2026-08-16').legalOver, 18,
    '週としての法定時間外は18時間');
});

/* ================================================================== *
 * 4. 上限の基準と休日労働
 * ================================================================== */

test('法定休日労働：週7日働いた週は1日が法定休日労働になり、その時間は時間外に数えない', () => {
  // 8/2(日)〜8/8(土) の7日×8時間＝56時間
  // 休日の8時間は休日労働。残り6日48時間のうち40時間超の8時間が法定時間外
  const records = days('2026-08-02', '2026-08-08').map(d => rec(EMP_ID, d, 1, 0));
  setup(records);
  const res = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');
  checkInvariants(res, { range: ['2026-08-02', '2026-08-08'], halfGrid: true });

  const holidays = res.daily.filter(d => d.holidayHours > 0);
  assert.equal(holidays.length, 1,
    '週7日勤務なのに法定休日労働が1日分だけ立っていない（労基法35条の週1日の休日）');
  assert.equal(holidays[0].holidayHours, 8, '法定休日の労働は、その日の実労働時間すべてが休日労働');
  assert.equal(holidays[0].dailyOver, 0, '法定休日の労働時間を時間外としても数えている（二重計上）');
  assert.equal(holidays[0].weeklyOver, 0, '法定休日の労働時間を週40時間超としても数えている');

  assert.equal(res.totals.overtime, 8,
    '休日労働の8時間を除いた48時間から法定40時間を超えた8時間が法定時間外');
  assert.equal(res.totals.withHoliday, 16, 'withHoliday は 時間外8 ＋ 休日労働8');
});

test('週6日以下なら法定休日労働は発生しない（休日は与えられている）', () => {
  const records = days('2026-08-03', '2026-08-08').map(d => rec(EMP_ID, d, 1, 0)); // 月〜土
  setup(records);
  const res = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');
  checkInvariants(res, { range: ['2026-08-02', '2026-08-08'], halfGrid: true });

  assert.equal(sum(res.daily, d => d.holidayHours), 0,
    '土曜や日曜を無条件に法定休日扱いしている（週1日の休日があれば法定休日労働は無い）');
  assert.equal(res.totals.overtime, res.totals.withHoliday,
    '休日労働が無いのに withHoliday が overtime と違う');
});

test('月45時間の判定は休日労働を含まない', () => {
  // 2026年2月は 2/1(日)〜2/28(土) がちょうど4週。毎週7日×8時間
  // 各週：休日労働8h、法定時間外8h → 月合計 時間外32h・休日労働32h・withHoliday 64h
  const records = days('2026-02-01', '2026-02-28').map(d => rec(EMP_ID, d, 1, 0));
  setup(records, { closingDay: 31 });
  const res = overtimeBreakdown(EMP_ID, '2026-02-01', '2026-02-28');
  checkInvariants(res, { range: ['2026-02-01', '2026-02-28'], halfGrid: true });

  assert.equal(res.months.length, 1);
  assert.equal(res.months[0].overtime, 32, '法定時間外が 8時間×4週 になっていない');
  assert.equal(res.months[0].withHoliday, 64, 'withHoliday が 時間外32＋休日労働32 になっていない');
  assert.equal(res.months[0].exceeds45, false,
    '月45時間の判定に休日労働を混ぜている（64>45 で誤判定していないか）');
  assert.equal(res.totals.months45Count, 0);
});

test('単月100時間未満の判定は休日労働を含む', () => {
  // 毎日 1人工＋残業2h＝10時間、4週×7日
  // 週：休日10h、他6日は日超2h×6=12h＋週超8h=20h → 月 時間外80h・休日40h・withHoliday 120h
  const records = days('2026-02-01', '2026-02-28').map(d => rec(EMP_ID, d, 1, 2));
  setup(records, { closingDay: 31 });
  const res = overtimeBreakdown(EMP_ID, '2026-02-01', '2026-02-28');
  checkInvariants(res, { range: ['2026-02-01', '2026-02-28'], halfGrid: true });

  assert.equal(res.months[0].overtime, 80, '法定時間外が 20時間×4週 になっていない');
  assert.equal(res.months[0].withHoliday, 120, 'withHoliday が 時間外80＋休日労働40 になっていない');
  assert.equal(res.months[0].exceeds100, true,
    '単月100時間の判定で休日労働を落としている（時間外だけなら80で見逃す）');
  assert.equal(res.months[0].exceeds45, true);
});

test('月45時間ちょうどは超えていない。45.5時間で超える', () => {
  // 平日のみ（週5日＝週40時間ちょうど）なので、日8時間超だけが積み上がる
  const a = [];
  assignMonthlyOvertime(a, EMP_ID, 2026, 2, 45);
  setup(a, { closingDay: 31 });
  const res = overtimeBreakdown(EMP_ID, '2026-02-01', '2026-02-28');
  checkInvariants(res, { range: ['2026-02-01', '2026-02-28'], halfGrid: true });
  assert.equal(res.months[0].overtime, 45);
  assert.equal(res.months[0].exceeds45, false, '45時間ちょうどは「45時間超」ではない');
  assert.equal(res.totals.months45Count, 0);

  const b = [];
  assignMonthlyOvertime(b, EMP_ID, 2026, 2, 45.5);
  setup(b, { closingDay: 31 });
  const res2 = overtimeBreakdown(EMP_ID, '2026-02-01', '2026-02-28');
  checkInvariants(res2, { range: ['2026-02-01', '2026-02-28'], halfGrid: true });
  assert.equal(res2.months[0].overtime, 45.5);
  assert.equal(res2.months[0].exceeds45, true, '45時間超を検出できていない');
  assert.equal(res2.totals.months45Count, 1);
});

test('単月100時間ちょうどは「100時間未満」を満たさないので上限超過', () => {
  // 2026年2月の平日20日 × 残業5h（1日13時間）＝ 時間外ちょうど100時間
  const a = weekdaysIn(2026, 2).map(d => rec(EMP_ID, d, 1, 5));
  setup(a, { closingDay: 31 });
  const res = overtimeBreakdown(EMP_ID, '2026-02-01', '2026-02-28');
  checkInvariants(res, { range: ['2026-02-01', '2026-02-28'], halfGrid: true });
  assert.equal(res.months[0].overtime, 100);
  assert.equal(res.months[0].withHoliday, 100);
  assert.equal(res.months[0].exceeds100, true,
    '基準は「100時間未満」。ちょうど100時間は上限超過');

  // 99.5時間なら超過しない
  const b = weekdaysIn(2026, 2).map((d, i) => rec(EMP_ID, d, 1, i === 19 ? 4.5 : 5));
  setup(b, { closingDay: 31 });
  const res2 = overtimeBreakdown(EMP_ID, '2026-02-01', '2026-02-28');
  checkInvariants(res2, { range: ['2026-02-01', '2026-02-28'], halfGrid: true });
  assert.equal(res2.months[0].overtime, 99.5);
  assert.equal(res2.months[0].exceeds100, false, '99.5時間で誤って上限超過にしている');
});

test('月45時間超は年6回まで。7回目が数えられる', () => {
  const records = [];
  for (let m = 1; m <= 12; m++) {
    assignMonthlyOvertime(records, EMP_ID, 2027, m, m <= 7 ? 46 : 10);
  }
  setup(records, { closingDay: 31 });
  const res = overtimeBreakdown(EMP_ID, '2027-01-01', '2027-12-31');
  checkInvariants(res, { range: ['2027-01-01', '2027-12-31'], halfGrid: true });

  assert.equal(res.months.length, 12, '1年が12区間にならない');
  res.months.slice(0, 7).forEach((m, i) => {
    assert.equal(m.overtime, 46, `${i + 1}月の時間外が46時間にならない`);
    assert.equal(m.exceeds45, true, `${i + 1}月の45時間超を検出できていない`);
  });
  res.months.slice(7).forEach((m, i) => {
    assert.equal(m.overtime, 10, `${i + 8}月の時間外が10時間にならない`);
    assert.equal(m.exceeds45, false);
  });
  assert.equal(res.totals.months45Count, 7,
    '月45時間超の回数が数えられていない（年6回までなので7回目は上限超過）');
  assert.ok(res.totals.months45Count > 6, '年6回の上限を超えたことが分かる値になっていない');
});

test('年360時間・年720時間の基準は休日労働を含まない totals.overtime', () => {
  // 2027-01-03(日)〜2027-12-25(土) の51週。毎日8時間×週7日
  const records = days('2027-01-03', '2027-12-31')  // 2027-01-03は日曜
    .map(d => rec(EMP_ID, d, 1, 0));
  setup(records, { closingDay: 31 });
  const res = overtimeBreakdown(EMP_ID, '2027-01-03', '2027-12-25'); // 日〜土で閉じる
  checkInvariants(res, { range: ['2027-01-03', '2027-12-25'] });

  const holidayTotal = res.totals.withHoliday - res.totals.overtime;
  assert.ok(holidayTotal > 0, '休日労働が集計されていない');
  assert.ok(res.totals.overtime < res.totals.withHoliday,
    '年360/720時間の判定に使う totals.overtime に休日労働が混ざっている');
  assert.ok(near(res.totals.overtime, sum(res.months, m => m.overtime)),
    '年計が月計の合計と一致しない');
  // 週8時間×51週＝408時間。年360時間を超えることを実際の集計で確認する
  assert.ok(res.totals.overtime > 360,
    '毎週48時間働いても年360時間を超えないと出ている（週40時間超を拾えていない）');
});

/* ================================================================== *
 * 5. 不変条件
 * ================================================================== */

test('出勤0の日は残業hが入っていても時間外にしない', () => {
  const records = [
    rec(EMP_ID, '2026-08-03', 0, 8),   // 休んだ日に残業hだけ残っている
    rec(EMP_ID, '2026-08-04', 1, 1),
  ];
  setup(records);
  const res = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');
  checkInvariants(res, { range: ['2026-08-02', '2026-08-08'], halfGrid: true });

  const d = day(res, '2026-08-03');
  assert.equal(d.workedHours, 0, '出勤0の日の残業hを労働時間に足している');
  assert.equal(d.dailyOver, 0);
  assert.equal(d.weeklyOver, 0);
  assert.equal(d.holidayHours, 0);
  assert.equal(res.totals.overtime, 1, '出勤した日の1時間だけが法定時間外');
});

test('勤怠が空でも落ちず、すべて0で返る', () => {
  setup([]);
  let res;
  assert.doesNotThrow(() => { res = overtimeBreakdown(EMP_ID, '2026-08-01', '2026-08-31'); },
    '勤怠が空だと落ちる');
  checkInvariants(res, { range: ['2026-08-01', '2026-08-31'], halfGrid: true });
  assert.equal(res.totals.overtime, 0);
  assert.equal(res.totals.withHoliday, 0);
  assert.equal(res.totals.months45Count, 0);
  assert.equal(sum(res.daily, d => d.workedHours), 0);
});

test('存在しない従業員でも落ちず、0で返る', () => {
  setup([rec(EMP_ID, '2026-08-03', 1, 3)]);
  let res;
  assert.doesNotThrow(() => { res = overtimeBreakdown('no_such_employee', '2026-08-01', '2026-08-31'); },
    '存在しない従業員IDで落ちる');
  checkInvariants(res, { range: ['2026-08-01', '2026-08-31'] });
  assert.equal(res.totals.overtime, 0, '他人の勤怠を拾っている');
  assert.equal(res.totals.withHoliday, 0);
});

test('他の従業員の勤怠を混ぜない', () => {
  const records = [
    rec(EMP_ID, '2026-08-03', 1, 1),
    ...days('2026-08-03', '2026-08-08').map(d => rec(OTHER_ID, d, 1, 4)),
  ];
  setup(records);
  const res = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');
  checkInvariants(res, { range: ['2026-08-02', '2026-08-08'], halfGrid: true });
  assert.equal(res.totals.overtime, 1, '別の従業員の勤怠が集計に混ざっている');
  assert.equal(res.daily.every(d => d.holidayHours === 0), true,
    '別の従業員の週7日勤務が対象者の休日労働として立っている');
});

test('期間外の勤怠を集計に入れない', () => {
  const records = [
    rec(EMP_ID, '2026-07-31', 1, 5),   // 期間前
    rec(EMP_ID, '2026-08-03', 1, 1),   // 期間内
    rec(EMP_ID, '2026-09-01', 1, 5),   // 期間後
  ];
  setup(records);
  const res = overtimeBreakdown(EMP_ID, '2026-08-01', '2026-08-31');
  checkInvariants(res, { range: ['2026-08-01', '2026-08-31'], halfGrid: true });
  assert.equal(res.totals.overtime, 1, '指定期間の外の勤怠を集計している');
});

test('壊れた入力（NaN・負値・過大値・型違い）でも負やNaNを返さない', () => {
  const records = [
    rec(EMP_ID, '2026-08-03', 1, NaN),
    rec(EMP_ID, '2026-08-04', -1, -5),
    rec(EMP_ID, '2026-08-05', 1, Infinity),
    rec(EMP_ID, '2026-08-06', '1', '2'),
    rec(EMP_ID, '2026-08-07', 1, 99999),
    rec(EMP_ID, '2026-08-08', null, undefined),
  ];
  setup(records);
  let res;
  assert.doesNotThrow(() => { res = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08'); },
    '壊れた入力で落ちる');
  checkInvariants(res, { range: ['2026-08-02', '2026-08-08'] });
  assert.ok(res.totals.overtime >= 0 && Number.isFinite(res.totals.overtime));
  assert.ok(res.totals.withHoliday >= 0 && Number.isFinite(res.totals.withHoliday));
});

test('同じデータを2回計算しても同じ結果になり、STATE を書き換えない', () => {
  const records = [
    ...days('2026-08-02', '2026-08-08').map(d => rec(EMP_ID, d, 1, 1)),
    ...days('2026-08-09', '2026-08-13').map(d => rec(EMP_ID, d, 0.5, 2)),
  ];
  setup(records, { closingDay: 20 });
  const before = JSON.stringify({
    employees: spec.STATE.employees,
    records: spec.STATE.records,
    settings: spec.STATE.settings,
  });

  const a = overtimeBreakdown(EMP_ID, '2026-07-21', '2026-08-20');
  const b = overtimeBreakdown(EMP_ID, '2026-07-21', '2026-08-20');
  checkInvariants(a, { range: ['2026-07-21', '2026-08-20'], halfGrid: true });

  assert.deepEqual(
    JSON.parse(JSON.stringify(b)),
    JSON.parse(JSON.stringify(a)),
    '同じ入力で2回目の結果が変わる（内部状態を持ち越している）'
  );
  assert.equal(
    JSON.stringify({
      employees: spec.STATE.employees,
      records: spec.STATE.records,
      settings: spec.STATE.settings,
    }),
    before,
    '集計が STATE（勤怠・従業員・設定）を書き換えている'
  );
});

test('計算の順序に依らない：勤怠の並びを入れ替えても同じ結果', () => {
  const records = days('2026-08-02', '2026-08-08').map((d, i) => rec(EMP_ID, d, 1, i % 3));
  setup(records.slice());
  const a = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');
  setup(records.slice().reverse());
  const b = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');
  assert.deepEqual(
    JSON.parse(JSON.stringify(b)),
    JSON.parse(JSON.stringify(a)),
    '勤怠の配列順で結果が変わる（日付順に並べ替えてから週を積み上げていない）'
  );
});

test('労働時間が増えて法定時間外が減ることはない（単調性）', () => {
  const base = days('2026-08-03', '2026-08-07').map(d => rec(EMP_ID, d, 1, 0));
  setup(base);
  const before = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');

  // 同じ週に労働を足す
  const more = base.map(r => Object.assign({}, r, { overtimeHours: 2 }));
  setup(more);
  const after = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');
  checkInvariants(after, { range: ['2026-08-02', '2026-08-08'], halfGrid: true });

  assert.ok(after.totals.overtime >= before.totals.overtime,
    '労働時間を増やしたのに法定時間外が減っている');
  assert.ok(after.totals.withHoliday >= before.totals.withHoliday,
    '労働時間を増やしたのに withHoliday が減っている');
  assert.equal(after.totals.overtime, 10, '毎日10時間×5日は日8時間超が2h×5＝10時間');
});

test('夜勤の労働も労働時間として扱い、時間外を減らさない', () => {
  // 要確認: 夜勤欄(nightAttendance / nightOvertimeHours)を労働時間に合算するかは仕様が未確定。
  // ここでは「合算するかどうかに関わらず、増えることはあっても減ってはならない」だけを固定する。
  const base = days('2026-08-03', '2026-08-07').map(d => rec(EMP_ID, d, 1, 1));
  setup(base);
  const before = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');

  const withNight = base.map(r => Object.assign({}, r, { nightAttendance: 1, nightOvertimeHours: 1 }));
  setup(withNight);
  const after = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');
  checkInvariants(after, { range: ['2026-08-02', '2026-08-08'] });

  assert.ok(after.totals.overtime >= before.totals.overtime,
    '夜勤を足したのに法定時間外が減っている');
  base.forEach(r => {
    assert.ok(day(after, r.date).workedHours >= 9,
      `${r.date}: 夜勤を足したら日勤分（1人工＋残業1h＝9時間）の労働時間が減っている`);
  });
});

test('daily・weekly・months・totals が互いに矛盾しない（複数月・締め日20日）', () => {
  const records = [];
  days('2026-06-21', '2026-09-20').forEach((d, i) => {
    const w = dow(d);
    if (w === 0) return;                       // 日曜は休み
    records.push(rec(EMP_ID, d, i % 11 === 0 ? 0.5 : 1, (i % 5) * 0.5));
  });
  setup(records, { closingDay: 20 });
  const res = overtimeBreakdown(EMP_ID, '2026-06-21', '2026-09-20');
  checkInvariants(res, { range: ['2026-06-21', '2026-09-20'], halfGrid: true });

  assert.equal(res.months.length, 3, '締め日20日で 6/21〜7/20, 7/21〜8/20, 8/21〜9/20 の3区間にならない');
  assert.equal(res.months[0].start, '2026-06-21');
  assert.equal(res.months[2].end, '2026-09-20');

  // 週ごとの legalOver は、その週の daily の時間外の合計と一致する
  res.weekly.forEach(w => {
    const inWeek = res.daily.filter(d => d.date >= w.weekStart && d.date <= w.weekEnd);
    assert.ok(near(w.legalOver, sum(inWeek, d => d.dailyOver + d.weeklyOver)),
      `週 ${w.weekStart}: legalOver(${w.legalOver}) が日ごとの合計と一致しない`);
    assert.ok(near(w.workedHours, sum(inWeek, d => d.workedHours)),
      `週 ${w.weekStart}: workedHours が日ごとの合計と一致しない`);
  });
  // 月ごとの overtime は、その月の daily の時間外の合計と一致する
  res.months.forEach(m => {
    const inMonth = res.daily.filter(d => d.date >= m.start && d.date <= m.end);
    assert.ok(near(m.overtime, sum(inMonth, d => d.dailyOver + d.weeklyOver)),
      `月 ${m.label}: overtime が日ごとの合計と一致しない`);
    assert.ok(near(m.withHoliday, sum(inMonth, d => d.dailyOver + d.weeklyOver + d.holidayHours)),
      `月 ${m.label}: withHoliday が日ごとの合計と一致しない`);
  });
});

test('同一従業員・同一日の重複レコードを二重に数えない', () => {
  const records = [
    rec(EMP_ID, '2026-08-03', 1, 2),
    Object.assign(rec(EMP_ID, '2026-08-03', 1, 2), { id: 'dup_1' }),
  ];
  setup(records);
  const res = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');
  checkInvariants(res, { range: ['2026-08-02', '2026-08-08'], halfGrid: true });
  assert.equal(day(res, '2026-08-03').workedHours, 10, '同じ日の勤怠を足し合わせている');
  assert.equal(res.totals.overtime, 2, '重複レコードで時間外が二重になっている');
});

test('入力上限いっぱいの残業hでも集計が破綻しない', () => {
  // 要確認: 1人工(8h)＋残業24h のような物理的にあり得ない入力を
  //         24時間で頭打ちにするか、入力どおり足すかは仕様が未確定。
  //         ここでは「有限・非負で、日→週→月→合計の辻褄が合う」ことだけを固定する。
  const records = [rec(EMP_ID, '2026-08-03', 1, 24)];
  setup(records);
  const res = overtimeBreakdown(EMP_ID, '2026-08-02', '2026-08-08');
  checkInvariants(res, { range: ['2026-08-02', '2026-08-08'] });
  const d = day(res, '2026-08-03');
  assert.ok(d.workedHours > 0, '上限いっぱいの入力が丸ごと捨てられている');
  assert.ok(near(d.dailyOver, Math.max(0, d.workedHours - 8)),
    '日8時間超の計算が労働時間と合っていない');
});
