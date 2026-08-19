from pathlib import Path

APP=Path('app.js')
SW=Path('sw.js')
TEST=Path('tests/core-invariants.test.js')

app=APP.read_text(encoding='utf-8')

# Deep-normalize archived invoice snapshots before they can be rendered again.
anchor="""function normalizeBackupIssue(raw,index){\n"""
helpers=r"""function normalizeBackupSnapshot(raw,index){
  const s=backupObj(raw,`発行履歴${index+1}件目のスナップショット`);
  if(!s.settings||!Array.isArray(s.reports))backupFail(`発行履歴${index+1}件目のスナップショット形式が不正です`);
  const serialized=JSON.stringify(s);
  if(serialized.length>5000000)backupFail(`発行履歴${index+1}件目のスナップショットが大きすぎます`);
  if(s.reports.length>5000)backupFail(`発行履歴${index+1}件目の明細件数が多すぎます`);
  const settings=normalizeBackupSettings(s.settings);
  const reports=s.reports.map((rawReport,ri)=>{
    const label=`発行履歴${index+1}件目の明細${ri+1}件目`;
    const item=backupObj(rawReport,label);
    const er=backupObj(item.emp,`${label}の従業員`);
    const empId=backupId(er.id,`${label}の従業員`);
    const empName=backupText(er.name,`${label}の従業員名`,200);
    if(!empName.trim())backupFail(`${label}の従業員名が空です`);
    const emp={
      id:empId,name:empName,
      dailyWage:backupNum(er.dailyWage,`${label}の日給`,1,WAGE_MAX),
      nightWage:backupNum(er.nightWage??0,`${label}の夜間単価`,0,WAGE_MAX),
      createdAt:backupText(er.createdAt,`${label}の従業員作成日時`,100)
    };
    const rr=backupObj(item.rep,`${label}の集計`);
    const reportEmployeeId=backupId(rr.employeeId,`${label}の集計従業員`);
    if(reportEmployeeId!==empId)backupFail(`${label}の従業員IDが一致しません`);
    if(!Array.isArray(rr.records))backupFail(`${label}の勤怠明細形式が不正です`);
    if(rr.records.length>1000)backupFail(`${label}の勤怠明細件数が多すぎます`);
    const ids=new Set(),dates=new Set();
    const records=rr.records.map((rawRec,rj)=>{
      const recLabel=`${label}の勤怠${rj+1}件目`;
      const r=backupObj(rawRec,recLabel);
      const id=backupId(r.id,recLabel),employeeId=backupId(r.employeeId,`${recLabel}の従業員`);
      if(employeeId!==empId)backupFail(`${recLabel}の従業員IDが一致しません`);
      if(ids.has(id))backupFail(`${label}の勤怠IDが重複しています: ${id}`);ids.add(id);
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
      if(r.note!=null)rec.note=backupText(r.note,`${recLabel}のメモ`,2000);
      return rec;
    });
    const money=(v,n)=>backupNum(v??0,`${label}の${n}`,0,1000000000000);
    const rep={
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
  });
  return {settings,reports};
}

"""
if app.count(anchor)!=1:
    raise SystemExit(f'ABORT: normalizeBackupIssue anchor count={app.count(anchor)}')
app=app.replace(anchor,helpers+anchor,1)

old_snapshot=r"""  let snapshot=null;
  if(o.snapshot!=null){
    snapshot=backupObj(o.snapshot,`発行履歴${index+1}件目のスナップショット`);
    if(!snapshot.settings||!Array.isArray(snapshot.reports))backupFail(`発行履歴${index+1}件目のスナップショット形式が不正です`);
    const serialized=JSON.stringify(snapshot);
    if(serialized.length>5000000)backupFail(`発行履歴${index+1}件目のスナップショットが大きすぎます`);
    snapshot=JSON.parse(serialized);
  }
"""
new_snapshot=r"""  let snapshot=null;
  if(o.snapshot!=null)snapshot=normalizeBackupSnapshot(o.snapshot,index);
"""
if app.count(old_snapshot)!=1:
    raise SystemExit(f'ABORT: old snapshot normalizer count={app.count(old_snapshot)}')
app=app.replace(old_snapshot,new_snapshot,1)

old_comment="""/* 電帳法の検索要件（日付・金額・取引先）を満たすファイル名 */\n"""
new_comment="""/* 保存後に日付・金額・取引先で識別しやすいファイル名 */\n"""
if app.count(old_comment)!=1:
    raise SystemExit(f'ABORT: issueFileName comment count={app.count(old_comment)}')
app=app.replace(old_comment,new_comment,1)
APP.write_text(app,encoding='utf-8')

sw=SW.read_text(encoding='utf-8')
old_sw="""    .then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))\n"""
new_sw="""    .then(ks=>Promise.all(ks.filter(k=>k.startsWith('invoice-')&&k!==CACHE).map(k=>caches.delete(k))))\n"""
if sw.count(old_sw)!=1:
    raise SystemExit(f'ABORT: SW activate cleanup count={sw.count(old_sw)}')
sw=sw.replace(old_sw,new_sw,1)
SW.write_text(sw,encoding='utf-8')

test_src=TEST.read_text(encoding='utf-8')
old_expose="""    periodReport, idx, invalidateIdx, validateBackupPayload, STATE,\n"""
new_expose="""    periodReport, idx, invalidateIdx, validateBackupPayload, normalizeBackupSnapshot, STATE,\n"""
if test_src.count(old_expose)!=1:
    raise SystemExit(f'ABORT: core expose count={test_src.count(old_expose)}')
test_src=test_src.replace(old_expose,new_expose,1)

if "sampleInvoiceSnapshot" not in test_src:
    insert_before="""test('復元処理は検証完了後に1トランザクションで永続化する', () => {\n"""
    tests=r"""function sampleInvoiceSnapshot() {
  return {
    settings: { defaultTransportFee: 1000, taxRate: 10, closingDay: 31, monthlyGoal: 0, issuer: {}, client: {}, bank: {} },
    reports: [{
      emp: { id: 'snap_emp', name: 'A', dailyWage: 10000, nightWage: 0, createdAt: '2026-08-01T00:00:00.000Z' },
      rep: {
        employeeId: 'snap_emp', totalAttendance: 1, totalNightAttendance: 0,
        totalDailyWage: 10000, totalOvertimePay: 0, totalNightWage: 0,
        totalNightOvertimePay: 0, totalTransportFee: 1000, grandTotal: 11000,
        records: [{ id: 'snap_rec', employeeId: 'snap_emp', date: '2026-08-01', attendance: 1, overtimeHours: 0, nightAttendance: 0, nightOvertimeHours: 0, transportFee: 1000 }]
      }
    }]
  };
}

function sampleIssue(snapshot) {
  return {
    id: 'issue1', issuedAt: '2026-08-02T00:00:00.000Z', invoiceNo: '2026-000001', issueDate: '2026年8月2日',
    period: { start: '2026-08-01', end: '2026-08-31', label: '2026年8月1日〜2026年8月31日', periodLabel: '2026年8月分' },
    clientName: '取引先', issuerName: '発行者', subtotal: 11000, tax: 1100, taxRate: 10, total: 12100,
    batch: false, voided: false, voidReason: '', snapshot
  };
}

test('validateBackupPayload: 発行スナップショット内部も数値型まで検証・正規化する', () => {
  const good = sampleBackup();
  good.invoiceLog = [sampleIssue(sampleInvoiceSnapshot())];
  const out = core.validateBackupPayload(good);
  assert.equal(out.invoiceLog[0].snapshot.settings.taxRate, 10);
  assert.equal(out.invoiceLog[0].snapshot.reports[0].rep.totalAttendance, 1);

  const badTax = sampleBackup();
  const snapTax = sampleInvoiceSnapshot();
  snapTax.settings.taxRate = '<img src=x onerror=alert(1)>';
  badTax.invoiceLog = [sampleIssue(snapTax)];
  assert.throws(() => core.validateBackupPayload(badTax), /数値が範囲外/);

  const badReport = sampleBackup();
  const snapReport = sampleInvoiceSnapshot();
  snapReport.reports[0].rep.totalAttendance = '<svg onload=alert(1)>';
  badReport.invoiceLog = [sampleIssue(snapReport)];
  assert.throws(() => core.validateBackupPayload(badReport), /数値が範囲外/);
});

test('validateBackupPayload: 発行スナップショットのID不整合と重複日を拒否する', () => {
  const mismatch = sampleBackup();
  const snapMismatch = sampleInvoiceSnapshot();
  snapMismatch.reports[0].rep.employeeId = 'other_emp';
  mismatch.invoiceLog = [sampleIssue(snapMismatch)];
  assert.throws(() => core.validateBackupPayload(mismatch), /従業員IDが一致/);

  const duplicate = sampleBackup();
  const snapDuplicate = sampleInvoiceSnapshot();
  snapDuplicate.reports[0].rep.records.push({ ...snapDuplicate.reports[0].rep.records[0], id: 'snap_rec2' });
  duplicate.invoiceLog = [sampleIssue(snapDuplicate)];
  assert.throws(() => core.validateBackupPayload(duplicate), /同じ日の勤怠が重複/);
});

"""
    if test_src.count(insert_before)!=1:
        raise SystemExit(f'ABORT: import test anchor count={test_src.count(insert_before)}')
    test_src=test_src.replace(insert_before,tests+insert_before,1)

if "Service Workerのactivate" not in test_src:
    test_src += r"""

test('Service Workerのactivateは当アプリの旧cacheだけを削除する', () => {
  const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.match(sw, /filter\(k=>k\.startsWith\('invoice-'\)&&k!==CACHE\)/);
  assert.doesNotMatch(sw, /filter\(k=>k!==CACHE\)/);
});
"""
TEST.write_text(test_src,encoding='utf-8')
print('Final audit gaps patched safely.')
