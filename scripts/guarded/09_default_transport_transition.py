from pathlib import Path

APP = Path('app.js')
TEST = Path('tests/core-invariants.test.js')

app = APP.read_text(encoding='utf-8')

# Add a pure decision helper before BOOT so the edge cases are testable.
anchor = """function recHasData(r){return (r.attendance||0)>0||(r.overtimeHours||0)>0||(r.nightAttendance||0)>0||(r.nightOvertimeHours||0)>0||(r.transportFee||0)>0||(r.manualTotal||0)>0;}\n\n/* ---------- index cache ---------- */\n"""
replacement = """function recHasData(r){return (r.attendance||0)>0||(r.overtimeHours||0)>0||(r.nightAttendance||0)>0||(r.nightOvertimeHours||0)>0||(r.transportFee||0)>0||(r.manualTotal||0)>0;}\n/* 休み状態から初めて日勤/夜勤を付ける瞬間だけ、車代の初期値を候補にする。\n   レコードが既に存在していても（先に残業等を触った場合でも）同じ扱いにする。\n   既存の車代が入っている場合は絶対に上書きしない。 */\nfunction shouldApplyDefaultTransport(rec,field,value){\n  if(value<=0||(field!=='attendance'&&field!=='nightAttendance'))return false;\n  const hadWork=(rec.attendance||0)>0||(rec.nightAttendance||0)>0;\n  const hasTransport=safeNum(rec.transportFee,INPUT_MAX.transportFee)>0;\n  return !hadWork&&!hasTransport;\n}\n\n/* ---------- index cache ---------- */\n"""
if app.count(anchor) != 1:
    raise SystemExit(f'ABORT: expected recHasData anchor once, found {app.count(anchor)}')
app = app.replace(anchor, replacement, 1)

old_set = """  let rec=STATE.records.find(r=>r.employeeId===selEmp&&r.date===date);\n  const isNew=!rec;\n  if(!rec){rec={id:uid(),employeeId:selEmp,date,attendance:0,overtimeHours:0,nightAttendance:0,nightOvertimeHours:0,transportFee:0};STATE.records.push(rec);}\n  rec[field]=v;\n  // 設定の「車代の初期値」は保存されるだけで使われていなかった。\n  // その日を初めて出勤にしたときだけ自動で入れる（既存の入力は上書きしない）\n  if(isNew&&v>0&&(field==='attendance'||field==='nightAttendance')){\n    const def=safeNum(STATE.settings.defaultTransportFee,INPUT_MAX.transportFee);\n    if(def>0)rec.transportFee=def;\n  }\n"""
new_set = """  let rec=STATE.records.find(r=>r.employeeId===selEmp&&r.date===date);\n  if(!rec){rec={id:uid(),employeeId:selEmp,date,attendance:0,overtimeHours:0,nightAttendance:0,nightOvertimeHours:0,transportFee:0};STATE.records.push(rec);}\n  const applyDefaultTransport=shouldApplyDefaultTransport(rec,field,v);\n  rec[field]=v;\n  // 「新規レコードか」ではなく「休み→初出勤への遷移か」で判断する。\n  // これで先に残業だけ入力した日でも初回出勤時に設定値が入り、既存車代は上書きしない。\n  if(applyDefaultTransport){\n    const def=safeNum(STATE.settings.defaultTransportFee,INPUT_MAX.transportFee);\n    if(def>0)rec.transportFee=def;\n  }\n"""
if app.count(old_set) != 1:
    raise SystemExit(f'ABORT: expected setAtt transport block once, found {app.count(old_set)}')
app = app.replace(old_set, new_set, 1)
APP.write_text(app, encoding='utf-8')

test_src = TEST.read_text(encoding='utf-8')
old_expose = """    overtimeRate, safeNum, dailyTotal, recHasData,\n    billingPeriod, calcTax, nextInvoiceNumber, daysInPeriod,\n"""
new_expose = """    overtimeRate, safeNum, dailyTotal, recHasData, shouldApplyDefaultTransport,\n    billingPeriod, calcTax, nextInvoiceNumber, daysInPeriod,\n"""
if test_src.count(old_expose) != 1:
    raise SystemExit(f'ABORT: expected transport helper expose anchor once, found {test_src.count(old_expose)}')
test_src = test_src.replace(old_expose, new_expose, 1)

name = "shouldApplyDefaultTransport: レコード作成済みでも休み→初出勤なら適用する"
if name not in test_src:
    test_src += r"""

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
"""
TEST.write_text(test_src, encoding='utf-8')
print('Default transport transition logic applied safely.')
