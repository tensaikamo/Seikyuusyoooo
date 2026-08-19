from pathlib import Path

APP = Path('app.js')
TEST = Path('tests/core-invariants.test.js')

app = APP.read_text(encoding='utf-8')

# 1) A snapshot report's aggregate must equal its component buckets.
old_rep = """    const rep={
      employeeId:reportEmployeeId,
      totalAttendance:backupNum(rr.totalAttendance??0,`${label}の日勤出勤数`,0,100000),
      totalNightAttendance:backupNum(rr.totalNightAttendance??0,`${label}の夜勤出勤数`,0,100000),
      totalDailyWage:money(rr.totalDailyWage,'日勤人工代'),
      totalOvertimePay:money(rr.totalOvertimePay,'日勤残業代'),
      totalNightWage:money(rr.totalNightWage,'夜勤人工代'),
      totalNightOvertimePay:money(rr.totalNightOvertimePay,'夜勤残業代'),
      totalTransportFee:money(rr.totalTransportFee,'車代'),
      grandTotal:money(rr.grandTotal,'合計'),
      records
    };
    return {emp,rep};
"""
new_rep = """    const rep={
      employeeId:reportEmployeeId,
      totalAttendance:backupNum(rr.totalAttendance??0,`${label}の日勤出勤数`,0,100000),
      totalNightAttendance:backupNum(rr.totalNightAttendance??0,`${label}の夜勤出勤数`,0,100000),
      totalDailyWage:money(rr.totalDailyWage,'日勤人工代'),
      totalOvertimePay:money(rr.totalOvertimePay,'日勤残業代'),
      totalNightWage:money(rr.totalNightWage,'夜勤人工代'),
      totalNightOvertimePay:money(rr.totalNightOvertimePay,'夜勤残業代'),
      totalTransportFee:money(rr.totalTransportFee,'車代'),
      grandTotal:money(rr.grandTotal,'合計'),
      records
    };
    const componentTotal=rep.totalDailyWage+rep.totalOvertimePay+rep.totalNightWage+rep.totalNightOvertimePay+rep.totalTransportFee;
    if(componentTotal!==rep.grandTotal)backupFail(`${label}の内訳合計と合計金額が一致しません`);
    return {emp,rep};
"""
if app.count(old_rep) != 1:
    raise SystemExit(f'ABORT: expected snapshot report aggregate block once, found {app.count(old_rep)}')
app = app.replace(old_rep, new_rep, 1)

# 2) Normalize issue fields to locals, then compare them with the immutable issuance snapshot.
old_issue = """  let snapshot=null;
  if(o.snapshot!=null)snapshot=normalizeBackupSnapshot(o.snapshot,index);
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
    ...(o.voidOperator?{voidOperator:backupText(o.voidOperator,`発行履歴${index+1}件目の取消担当者`,200)}:{}),
    ...(o.voidedAt?{voidedAt:backupText(o.voidedAt,`発行履歴${index+1}件目の取消日時`,80)}:{}),
    ...(o.voidOf?{voidOf:backupId(o.voidOf,`発行履歴${index+1}件目の取消元`)}:{}),
    snapshot
  };
"""
new_issue = """  let snapshot=null;
  if(o.snapshot!=null)snapshot=normalizeBackupSnapshot(o.snapshot,index);
  const invoiceNo=backupNoMarkup(o.invoiceNo,`発行履歴${index+1}件目の請求番号`,120);
  const issueDate=backupNoMarkup(o.issueDate,`発行履歴${index+1}件目の発行日`,80);
  const clientName=backupText(o.clientName,`発行履歴${index+1}件目の取引先`,300);
  const issuerName=backupText(o.issuerName,`発行履歴${index+1}件目の発行者`,300);
  const subtotal=backupNum(o.subtotal,`発行履歴${index+1}件目の小計`,-1000000000000,1000000000000);
  const tax=backupNum(o.tax,`発行履歴${index+1}件目の税額`,-1000000000000,1000000000000);
  const taxRate=backupNum(o.taxRate,`発行履歴${index+1}件目の税率`,0,100);
  const total=backupNum(o.total,`発行履歴${index+1}件目の合計`,-1000000000000,1000000000000);
  if(snapshot){
    const snapSubtotal=snapshot.reports.reduce((sum,x)=>sum+x.rep.grandTotal,0);
    const snapTax=calcTax(snapSubtotal,snapshot.settings.taxRate);
    const snapTotal=snapSubtotal+snapTax;
    if(subtotal!==snapSubtotal||tax!==snapTax||total!==snapTotal||taxRate!==snapshot.settings.taxRate){
      backupFail(`発行履歴${index+1}件目の保存金額とスナップショットが一致しません`);
    }
    const expectedClient=snapshot.settings.client.companyName||'（請求先未設定）';
    const expectedIssuer=snapshot.settings.issuer.companyName||'';
    if(clientName!==expectedClient||issuerName!==expectedIssuer){
      backupFail(`発行履歴${index+1}件目の取引先または発行者とスナップショットが一致しません`);
    }
    snapshot.reports.forEach((x,ri)=>x.rep.records.forEach((r,rj)=>{
      if(r.date<start||r.date>end)backupFail(`発行履歴${index+1}件目の明細${ri+1}件目の勤怠${rj+1}件目が請求期間外です`);
    }));
  }
  return {
    id:backupId(o.id,`発行履歴${index+1}件目`),issuedAt,invoiceNo,issueDate,
    period:{start,end,label:backupNoMarkup(period.label,`発行履歴${index+1}件目の期間表示`,120),periodLabel:backupNoMarkup(period.periodLabel,`発行履歴${index+1}件目の請求月表示`,80)},
    clientName,issuerName,subtotal,tax,taxRate,total,
    batch:!!o.batch,voided:!!o.voided,voidReason:backupText(o.voidReason,`発行履歴${index+1}件目の取消理由`,1000),
    ...(o.voidOperator?{voidOperator:backupText(o.voidOperator,`発行履歴${index+1}件目の取消担当者`,200)}:{}),
    ...(o.voidedAt?{voidedAt:backupText(o.voidedAt,`発行履歴${index+1}件目の取消日時`,80)}:{}),
    ...(o.voidOf?{voidOf:backupId(o.voidOf,`発行履歴${index+1}件目の取消元`)}:{}),
    snapshot
  };
"""
if app.count(old_issue) != 1:
    raise SystemExit(f'ABORT: expected issue normalizer block once, found {app.count(old_issue)}')
app = app.replace(old_issue, new_issue, 1)
APP.write_text(app, encoding='utf-8')

# 3) Add explicit corruption tests using the existing sample helpers.
test_src = TEST.read_text(encoding='utf-8')
name = "validateBackupPayload: 発行履歴の保存金額とsnapshot再計算額を照合する"
if name not in test_src:
    anchor = """test('復元処理は検証完了後に1トランザクションで永続化する', () => {\n"""
    block = r"""test('validateBackupPayload: 発行履歴の保存金額とsnapshot再計算額を照合する', () => {
  const good = sampleBackup();
  good.invoiceLog = [sampleIssue(sampleInvoiceSnapshot())];
  assert.doesNotThrow(() => core.validateBackupPayload(good));

  const topLevelTamper = sampleBackup();
  const issue = sampleIssue(sampleInvoiceSnapshot());
  issue.total = 999999;
  topLevelTamper.invoiceLog = [issue];
  assert.throws(() => core.validateBackupPayload(topLevelTamper), /保存金額とスナップショットが一致/);

  const aggregateTamper = sampleBackup();
  const snap = sampleInvoiceSnapshot();
  snap.reports[0].rep.totalTransportFee = 9999;
  aggregateTamper.invoiceLog = [sampleIssue(snap)];
  assert.throws(() => core.validateBackupPayload(aggregateTamper), /内訳合計と合計金額が一致/);
});

test('validateBackupPayload: 発行履歴の当事者と請求期間をsnapshotと照合する', () => {
  const partyTamper = sampleBackup();
  const partyIssue = sampleIssue(sampleInvoiceSnapshot());
  partyIssue.clientName = '別の取引先';
  partyTamper.invoiceLog = [partyIssue];
  assert.throws(() => core.validateBackupPayload(partyTamper), /取引先または発行者とスナップショットが一致/);

  const periodTamper = sampleBackup();
  const snap = sampleInvoiceSnapshot();
  snap.reports[0].rep.records[0].date = '2026-09-01';
  const periodIssue = sampleIssue(snap);
  periodTamper.invoiceLog = [periodIssue];
  assert.throws(() => core.validateBackupPayload(periodTamper), /請求期間外/);
});

"""
    if test_src.count(anchor) != 1:
        raise SystemExit(f'ABORT: expected import-order test anchor once, found {test_src.count(anchor)}')
    test_src = test_src.replace(anchor, block + anchor, 1)
TEST.write_text(test_src, encoding='utf-8')
print('Invoice log/snapshot integrity checks applied safely.')
