from pathlib import Path

APP=Path('app.js')
TEST=Path('tests/core-invariants.test.js')
app=APP.read_text(encoding='utf-8')
test=TEST.read_text(encoding='utf-8')

def once(text,old,new,label):
    n=text.count(old)
    if n!=1: raise SystemExit(f'ABORT {label}: expected once, found {n}')
    return text.replace(old,new,1)

# Pass legacy-mode through invoice/snapshot normalization.
app=once(app,"function normalizeBackupSnapshot(raw,index){","function normalizeBackupSnapshot(raw,index,legacy=false){",'snapshot signature')
app=once(app,"function normalizeBackupIssue(raw,index){","function normalizeBackupIssue(raw,index,legacy=false){",'issue signature')
app=once(app,"  if(o.snapshot!=null)snapshot=normalizeBackupSnapshot(o.snapshot,index);","  if(o.snapshot!=null)snapshot=normalizeBackupSnapshot(o.snapshot,index,legacy);",'snapshot call')

# Historical snapshots are evidence of what the older app actually issued. For legacy
# backups, validate shape/safety with generous archival bounds instead of today's live-input caps.
old="""      id:empId,name:empName,
      dailyWage:backupNum(er.dailyWage,`${label}の日給`,1,WAGE_MAX),
      nightWage:backupNum(er.nightWage??0,`${label}の夜間単価`,0,WAGE_MAX),
      createdAt:backupText(er.createdAt,`${label}の従業員作成日時`,100)
"""
new="""      id:empId,name:empName,
      dailyWage:backupNum(er.dailyWage,`${label}の日給`,legacy?0:1,legacy?1000000000000:WAGE_MAX),
      nightWage:backupNum(er.nightWage??0,`${label}の夜間単価`,0,legacy?1000000000000:WAGE_MAX),
      createdAt:backupText(er.createdAt,`${label}の従業員作成日時`,100)
"""
app=once(app,old,new,'legacy snapshot wage bounds')

old="""      if(ids.has(id))backupFail(`${label}の勤怠IDが重複しています: ${id}`);ids.add(id);
      const date=backupDate(r.date,recLabel);
      if(dates.has(date))backupFail(`${label}で同じ日の勤怠が重複しています: ${date}`);dates.add(date);
      const rec={
        id,employeeId,date,
        attendance:backupNum(r.attendance??0,`${recLabel}の出勤数`,0,INPUT_MAX.attendance),
        overtimeHours:backupNum(r.overtimeHours??0,`${recLabel}の残業時間`,0,INPUT_MAX.overtimeHours),
        nightAttendance:backupNum(r.nightAttendance??0,`${recLabel}の夜勤出勤数`,0,INPUT_MAX.nightAttendance),
        nightOvertimeHours:backupNum(r.nightOvertimeHours??0,`${recLabel}の夜間残業`,0,INPUT_MAX.nightOvertimeHours),
        transportFee:backupNum(r.transportFee??0,`${recLabel}の車代`,0,INPUT_MAX.transportFee)
      };
      if(r.manualTotal!=null)rec.manualTotal=backupNum(r.manualTotal,`${recLabel}の手入力合計`,0,INPUT_MAX.manualTotal);
"""
new="""      if(!legacy&&ids.has(id))backupFail(`${label}の勤怠IDが重複しています: ${id}`);ids.add(id);
      const date=backupDate(r.date,recLabel);
      if(!legacy&&dates.has(date))backupFail(`${label}で同じ日の勤怠が重複しています: ${date}`);dates.add(date);
      const archivalCountMax=100000,archivalMoneyMax=1000000000000;
      const rec={
        id,employeeId,date,
        attendance:backupNum(r.attendance??0,`${recLabel}の出勤数`,0,legacy?archivalCountMax:INPUT_MAX.attendance),
        overtimeHours:backupNum(r.overtimeHours??0,`${recLabel}の残業時間`,0,legacy?archivalCountMax:INPUT_MAX.overtimeHours),
        nightAttendance:backupNum(r.nightAttendance??0,`${recLabel}の夜勤出勤数`,0,legacy?archivalCountMax:INPUT_MAX.nightAttendance),
        nightOvertimeHours:backupNum(r.nightOvertimeHours??0,`${recLabel}の夜間残業`,0,legacy?archivalCountMax:INPUT_MAX.nightOvertimeHours),
        transportFee:backupNum(r.transportFee??0,`${recLabel}の車代`,0,legacy?archivalMoneyMax:INPUT_MAX.transportFee)
      };
      if(r.manualTotal!=null)rec.manualTotal=backupNum(r.manualTotal,`${recLabel}の手入力合計`,0,legacy?archivalMoneyMax:INPUT_MAX.manualTotal);
"""
app=once(app,old,new,'legacy snapshot record bounds')

# For every snapshot, the stored component buckets must sum to grandTotal. Only new
# schemaVersion=1 snapshots are re-derived with today's calculation rules.
old="""    const expectedRep={
      totalAttendance:expectedAttendance,totalNightAttendance:expectedNightAttendance,
      totalDailyWage:expectedDailyWage,totalOvertimePay:expectedOvertimePay,
      totalNightWage:expectedNightWage,totalNightOvertimePay:expectedNightOvertimePay,
      totalTransportFee:expectedTransportFee,
      grandTotal:expectedDailyWage+expectedOvertimePay+expectedNightWage+expectedNightOvertimePay+expectedTransportFee
    };
    Object.entries(expectedRep).forEach(([key,value])=>{
      if(rep[key]!==value)backupFail(`${label}の集計値が勤怠明細と一致しません (${key})`);
    });
    return {emp,rep};
"""
new="""    const componentTotal=rep.totalDailyWage+rep.totalOvertimePay+rep.totalNightWage+rep.totalNightOvertimePay+rep.totalTransportFee;
    if(componentTotal!==rep.grandTotal)backupFail(`${label}の内訳合計と合計金額が一致しません`);
    if(!legacy){
      const expectedRep={
        totalAttendance:expectedAttendance,totalNightAttendance:expectedNightAttendance,
        totalDailyWage:expectedDailyWage,totalOvertimePay:expectedOvertimePay,
        totalNightWage:expectedNightWage,totalNightOvertimePay:expectedNightOvertimePay,
        totalTransportFee:expectedTransportFee,
        grandTotal:expectedDailyWage+expectedOvertimePay+expectedNightWage+expectedNightOvertimePay+expectedTransportFee
      };
      Object.entries(expectedRep).forEach(([key,value])=>{
        if(rep[key]!==value)backupFail(`${label}の集計値が勤怠明細と一致しません (${key})`);
      });
    }
    return {emp,rep};
"""
app=once(app,old,new,'legacy calculation compatibility')

# Top-level issue fields must still match the immutable snapshot regardless of age.
old="""    if(total!==subtotal+tax)backupFail(`発行履歴${index+1}件目の合計が小計・税額と一致しません`);
  }
  return {
"""
new="""    if(total!==subtotal+tax)backupFail(`発行履歴${index+1}件目の合計が小計・税額と一致しません`);
    const expectedClient=snapshot.settings.client.companyName||'（請求先未設定）';
    const expectedIssuer=snapshot.settings.issuer.companyName||'';
    const actualClient=backupText(o.clientName,`発行履歴${index+1}件目の取引先`,300);
    const actualIssuer=backupText(o.issuerName,`発行履歴${index+1}件目の発行者`,300);
    if(actualClient!==expectedClient||actualIssuer!==expectedIssuer)backupFail(`発行履歴${index+1}件目の取引先または発行者がスナップショットと一致しません`);
    snapshot.reports.forEach((x,ri)=>x.rep.records.forEach((r,rj)=>{
      if(r.date<start||r.date>end)backupFail(`発行履歴${index+1}件目の明細${ri+1}件目の勤怠${rj+1}件目が請求期間外です`);
    }));
  }
  return {
"""
app=once(app,old,new,'party and period integrity')

# Determine legacy mode once at top level and use it only for historical invoice snapshots.
old="""  const logIds=new Set();
  const invoiceLog=invoiceRaw.map((x,i)=>{
    const issue=normalizeBackupIssue(x,i);
"""
new="""  const legacyBackup=o.schemaVersion==null;
  const logIds=new Set();
  const invoiceLog=invoiceRaw.map((x,i)=>{
    const issue=normalizeBackupIssue(x,i,legacyBackup);
"""
app=once(app,old,new,'legacy mode dispatch')

# Make sample snapshot parties match actual buildIssue behavior.
old="""    settings: { defaultTransportFee: 1000, taxRate: 10, closingDay: 31, monthlyGoal: 0, issuer: {}, client: {}, bank: {} },
"""
new="""    settings: { defaultTransportFee: 1000, taxRate: 10, closingDay: 31, monthlyGoal: 0, issuer: { companyName: '発行者' }, client: { companyName: '取引先' }, bank: {} },
"""
# This exact line appears in sampleInvoiceSnapshot only after the sampleBackup line earlier;
# replace the last occurrence to avoid changing the live-backup sample.
pos=test.rfind(old)
if pos<0: raise SystemExit('ABORT sample snapshot settings anchor not found')
test=test[:pos]+new+test[pos+len(old):]

# New-format duplicate snapshot test remains strict.
old="""  const duplicate = sampleBackup();
  const snapDuplicate = sampleInvoiceSnapshot();
"""
new="""  const duplicate = sampleBackup();
  duplicate.schemaVersion = 1;
  const snapDuplicate = sampleInvoiceSnapshot();
"""
test=once(test,old,new,'new schema duplicate test')

# Historical compatibility regression: old calculation semantics and old oversized snapshot values
# must remain restorable when schemaVersion is absent, but the new schema stays strict.
anchor="""test('validateBackupPayload: 発行スナップショットのID不整合と重複日を拒否する', () => {\n"""
block="""test('validateBackupPayload: schemaVersionなしの旧発行snapshotは当時の計算結果を保存したまま復元できる', () => {\n  const legacy = sampleBackup();\n  const snap = sampleInvoiceSnapshot();\n  const rec = snap.reports[0].rep.records[0];\n  rec.attendance = 0; rec.overtimeHours = 2; rec.transportFee = 1000;\n  const rep = snap.reports[0].rep;\n  rep.totalAttendance = 0; rep.totalDailyWage = 0; rep.totalOvertimePay = 3125; rep.totalTransportFee = 1000; rep.grandTotal = 4125;\n  const issue = sampleIssue(snap);\n  issue.subtotal = 4125; issue.tax = 412; issue.total = 4537;\n  legacy.invoiceLog = [issue];\n  assert.doesNotThrow(() => core.validateBackupPayload(legacy));\n\n  const current = structuredClone ? null : null; // marker only; Node VM does not expose structuredClone\n  const strict = sampleBackup(); strict.schemaVersion = 1; strict.invoiceLog = [issue];\n  assert.throws(() => core.validateBackupPayload(strict), /集計値が勤怠明細と一致/);\n});\n\ntest('validateBackupPayload: 旧発行snapshotの過去上限超過値は履歴として保持し、新schemaでは拒否する', () => {\n  const legacy = sampleBackup();\n  const snap = sampleInvoiceSnapshot();\n  snap.reports[0].emp.dailyWage = 2000000;\n  const rep = snap.reports[0].rep;\n  rep.totalDailyWage = 2000000; rep.totalTransportFee = 1000; rep.totalOvertimePay = 0; rep.grandTotal = 2001000;\n  const issue = sampleIssue(snap); issue.subtotal = 2001000; issue.tax = 200100; issue.total = 2201100;\n  legacy.invoiceLog = [issue];\n  assert.doesNotThrow(() => core.validateBackupPayload(legacy));\n\n  const strict = sampleBackup(); strict.schemaVersion = 1; strict.invoiceLog = [issue];\n  assert.throws(() => core.validateBackupPayload(strict), /範囲外/);\n});\n\n"""+anchor
# Remove an accidental unsupported marker before writing.
block=block.replace("\n  const current = structuredClone ? null : null; // marker only; Node VM does not expose structuredClone\n", "\n")
test=once(test,anchor,block,'legacy compatibility tests')

# Party / period tamper checks.
anchor="""test('復元処理は検証完了後に1トランザクションで永続化する', () => {\n"""
block="""test('validateBackupPayload: 発行履歴の取引先と請求期間をsnapshotと照合する', () => {\n  const party = sampleBackup();\n  const partyIssue = sampleIssue(sampleInvoiceSnapshot()); partyIssue.clientName = '別会社'; party.invoiceLog = [partyIssue];\n  assert.throws(() => core.validateBackupPayload(party), /取引先または発行者がスナップショットと一致/);\n\n  const period = sampleBackup();\n  const periodSnap = sampleInvoiceSnapshot(); periodSnap.reports[0].rep.records[0].date = '2026-09-01';\n  const periodIssue = sampleIssue(periodSnap); period.invoiceLog = [periodIssue];\n  assert.throws(() => core.validateBackupPayload(period), /請求期間外/);\n});\n\n"""+anchor
test=once(test,anchor,block,'party period tests')

APP.write_text(app,encoding='utf-8')
TEST.write_text(test,encoding='utf-8')
print('legacy compatibility patch applied')
