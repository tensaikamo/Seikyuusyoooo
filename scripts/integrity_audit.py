from pathlib import Path

APP = Path('app.js')
TEST = Path('tests/core-invariants.test.js')

app = APP.read_text(encoding='utf-8')

old_locals = """  const subtotal=backupNum(o.subtotal,`発行履歴${index+1}件目の小計`,-1000000000000,1000000000000);
  const tax=backupNum(o.tax,`発行履歴${index+1}件目の税額`,-1000000000000,1000000000000);
  const taxRate=backupNum(o.taxRate,`発行履歴${index+1}件目の税率`,0,100);
  const total=backupNum(o.total,`発行履歴${index+1}件目の合計`,-1000000000000,1000000000000);
  if(snapshot){
"""
new_locals = """  const subtotal=backupNum(o.subtotal,`発行履歴${index+1}件目の小計`,-1000000000000,1000000000000);
  const tax=backupNum(o.tax,`発行履歴${index+1}件目の税額`,-1000000000000,1000000000000);
  const taxRate=backupNum(o.taxRate,`発行履歴${index+1}件目の税率`,0,100);
  const total=backupNum(o.total,`発行履歴${index+1}件目の合計`,-1000000000000,1000000000000);
  const clientName=backupText(o.clientName,`発行履歴${index+1}件目の取引先`,300);
  const issuerName=backupText(o.issuerName,`発行履歴${index+1}件目の発行者`,300);
  if(snapshot){
"""
if app.count(old_locals) != 1:
    raise SystemExit(f'ABORT: expected issue local fields once, found {app.count(old_locals)}')
app = app.replace(old_locals, new_locals, 1)

old_snapshot_end = """    if(tax!==calcTax(subtotal,taxRate))backupFail(`発行履歴${index+1}件目の税額がスナップショットと一致しません`);
    if(total!==subtotal+tax)backupFail(`発行履歴${index+1}件目の合計が小計・税額と一致しません`);
  }
"""
new_snapshot_end = """    if(tax!==calcTax(subtotal,taxRate))backupFail(`発行履歴${index+1}件目の税額がスナップショットと一致しません`);
    if(total!==subtotal+tax)backupFail(`発行履歴${index+1}件目の合計が小計・税額と一致しません`);
    const expectedClient=snapshot.settings.client.companyName||'（請求先未設定）';
    const expectedIssuer=snapshot.settings.issuer.companyName||'';
    if(clientName!==expectedClient||issuerName!==expectedIssuer){
      backupFail(`発行履歴${index+1}件目の取引先または発行者がスナップショットと一致しません`);
    }
    snapshot.reports.forEach((x,ri)=>x.rep.records.forEach((r,rj)=>{
      if(r.date<start||r.date>end){
        backupFail(`発行履歴${index+1}件目の明細${ri+1}件目の勤怠${rj+1}件目が請求期間外です`);
      }
    }));
  }
"""
if app.count(old_snapshot_end) != 1:
    raise SystemExit(f'ABORT: expected snapshot issue checks once, found {app.count(old_snapshot_end)}')
app = app.replace(old_snapshot_end, new_snapshot_end, 1)

old_return = """    clientName:backupText(o.clientName,`発行履歴${index+1}件目の取引先`,300),
    issuerName:backupText(o.issuerName,`発行履歴${index+1}件目の発行者`,300),
    subtotal,tax,taxRate,total,
"""
new_return = """    clientName,issuerName,subtotal,tax,taxRate,total,
"""
if app.count(old_return) != 1:
    raise SystemExit(f'ABORT: expected issue party return fields once, found {app.count(old_return)}')
app = app.replace(old_return, new_return, 1)
APP.write_text(app, encoding='utf-8')

test_src = TEST.read_text(encoding='utf-8')
name = "validateBackupPayload: 発行履歴の当事者と請求期間をsnapshotと照合する"
if name not in test_src:
    anchor = """test('復元処理は検証完了後に1トランザクションで永続化する', () => {\n"""
    block = r"""test('validateBackupPayload: 発行履歴の当事者と請求期間をsnapshotと照合する', () => {
  const partyTamper = sampleBackup();
  const partyIssue = sampleIssue(sampleInvoiceSnapshot());
  partyIssue.clientName = '別の取引先';
  partyTamper.invoiceLog = [partyIssue];
  assert.throws(() => core.validateBackupPayload(partyTamper), /取引先または発行者がスナップショットと一致/);

  const periodTamper = sampleBackup();
  const snap = sampleInvoiceSnapshot();
  snap.reports[0].rep.records[0].date = '2026-09-01';
  periodTamper.invoiceLog = [sampleIssue(snap)];
  assert.throws(() => core.validateBackupPayload(periodTamper), /請求期間外/);
});

"""
    if test_src.count(anchor) != 1:
        raise SystemExit(f'ABORT: expected import-order test anchor once, found {test_src.count(anchor)}')
    test_src = test_src.replace(anchor, block + anchor, 1)
TEST.write_text(test_src, encoding='utf-8')
print('Remaining invoice party/period integrity checks applied safely.')
