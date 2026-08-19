from pathlib import Path

APP=Path('app.js')
TEST=Path('tests/core-invariants.test.js')
app=APP.read_text(encoding='utf-8')
test=TEST.read_text(encoding='utf-8')

def once(text,old,new,label):
    n=text.count(old)
    if n!=1: raise SystemExit(f'ABORT {label}: expected once, found {n}')
    return text.replace(old,new,1)

old="""  if(!Array.isArray(invoiceRaw))backupFail('発行履歴の形式が不正です');
  if(o.employees.length>5000||o.records.length>500000||invoiceRaw.length>100000)backupFail('バックアップの件数が上限を超えています');

  const empIds=new Set();
"""
new="""  if(!Array.isArray(invoiceRaw))backupFail('発行履歴の形式が不正です');
  if(o.employees.length>5000||o.records.length>500000||invoiceRaw.length>100000)backupFail('バックアップの件数が上限を超えています');
  const legacyBackup=o.schemaVersion==null;
  const legacyMoneyMax=1000000000000,legacyHoursMax=100000;

  const empIds=new Set();
"""
app=once(app,old,new,'legacy live mode declaration')

old="""    return {id,name,dailyWage:backupNum(e.dailyWage,`${name}の日給`,1,WAGE_MAX),nightWage:backupNum(e.nightWage??0,`${name}の夜間単価`,0,WAGE_MAX),createdAt:backupText(e.createdAt,`${name}の作成日時`,100)};
"""
new="""    return {id,name,
      dailyWage:backupNum(e.dailyWage,`${name}の日給`,1,legacyBackup?legacyMoneyMax:WAGE_MAX),
      nightWage:backupNum(e.nightWage??0,`${name}の夜間単価`,0,legacyBackup?legacyMoneyMax:WAGE_MAX),
      createdAt:backupText(e.createdAt,`${name}の作成日時`,100)};
"""
app=once(app,old,new,'legacy live wage bounds')

old="""      attendance:backupNum(r.attendance??0,`勤怠${i+1}件目の出勤数`,0,INPUT_MAX.attendance),
      overtimeHours:backupNum(r.overtimeHours??0,`勤怠${i+1}件目の残業時間`,0,INPUT_MAX.overtimeHours),
      nightAttendance:backupNum(r.nightAttendance??0,`勤怠${i+1}件目の夜勤出勤数`,0,INPUT_MAX.nightAttendance),
      nightOvertimeHours:backupNum(r.nightOvertimeHours??0,`勤怠${i+1}件目の夜間残業`,0,INPUT_MAX.nightOvertimeHours),
      transportFee:backupNum(r.transportFee??0,`勤怠${i+1}件目の車代`,0,INPUT_MAX.transportFee)};
    if(r.manualTotal!=null)rec.manualTotal=backupNum(r.manualTotal,`勤怠${i+1}件目の手入力合計`,0,INPUT_MAX.manualTotal);
"""
new="""      attendance:backupNum(r.attendance??0,`勤怠${i+1}件目の出勤数`,0,INPUT_MAX.attendance),
      overtimeHours:backupNum(r.overtimeHours??0,`勤怠${i+1}件目の残業時間`,0,legacyBackup?legacyHoursMax:INPUT_MAX.overtimeHours),
      nightAttendance:backupNum(r.nightAttendance??0,`勤怠${i+1}件目の夜勤出勤数`,0,INPUT_MAX.nightAttendance),
      nightOvertimeHours:backupNum(r.nightOvertimeHours??0,`勤怠${i+1}件目の夜間残業`,0,legacyBackup?legacyHoursMax:INPUT_MAX.nightOvertimeHours),
      transportFee:backupNum(r.transportFee??0,`勤怠${i+1}件目の車代`,0,legacyBackup?legacyMoneyMax:INPUT_MAX.transportFee)};
    if(r.manualTotal!=null)rec.manualTotal=backupNum(r.manualTotal,`勤怠${i+1}件目の手入力合計`,0,legacyBackup?legacyMoneyMax:INPUT_MAX.manualTotal);
"""
app=once(app,old,new,'legacy live record bounds')

old="""  const legacyBackup=o.schemaVersion==null;
  const logIds=new Set();
"""
new="""  const logIds=new Set();
"""
app=once(app,old,new,'remove duplicate legacy declaration')

old="""test('validateBackupPayload: 入力上限超過と未知の将来schemaを拒否する', () => {
  const high = sampleBackup();
  high.records[0].transportFee = 100001;
"""
new="""test('validateBackupPayload: 入力上限超過と未知の将来schemaを拒否する', () => {
  const high = sampleBackup();
  high.schemaVersion = 1;
  high.records[0].transportFee = 100001;
"""
test=once(test,old,new,'strict current-cap test schema')

anchor="""test('validateBackupPayload: 発行スナップショット内部も数値型まで検証・正規化する', () => {\n"""
block="""test('validateBackupPayload: schemaVersionなしの旧ライブデータは上限導入前のraw値を保持できる', () => {\n  const legacy = sampleBackup();\n  legacy.employees[0].dailyWage = 2000000;\n  legacy.records[0].overtimeHours = 100;\n  legacy.records[0].nightOvertimeHours = 100;\n  legacy.records[0].transportFee = 1000000;\n  legacy.records[0].manualTotal = 50000000;\n  const out = core.validateBackupPayload(legacy);\n  assert.equal(out.employees[0].dailyWage, 2000000);\n  assert.equal(out.records[0].overtimeHours, 100);\n  assert.equal(out.records[0].transportFee, 1000000);\n  assert.equal(out.records[0].manualTotal, 50000000);\n\n  const strict = sampleBackup();\n  strict.schemaVersion = 1;\n  strict.employees[0].dailyWage = 2000000;\n  strict.records[0].overtimeHours = 100;\n  strict.records[0].transportFee = 1000000;\n  strict.records[0].manualTotal = 50000000;\n  assert.throws(() => core.validateBackupPayload(strict), /範囲外/);\n});\n\n"""+anchor
test=once(test,anchor,block,'legacy live compatibility test')

APP.write_text(app,encoding='utf-8')
TEST.write_text(test,encoding='utf-8')
print('legacy live-data compatibility patch applied')