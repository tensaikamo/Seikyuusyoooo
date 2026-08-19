from pathlib import Path

APP = Path('app.js')
TEST = Path('tests/core-invariants.test.js')

app = APP.read_text(encoding='utf-8')
test = TEST.read_text(encoding='utf-8')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'ABORT {label}: expected anchor once, found {count}')
    return text.replace(old, new, 1)

# 1) Snapshot aggregates must match the actual normalized attendance records.
anchor = """    const money=(v,n)=>backupNum(v??0,`${label}の${n}`,0,1000000000000);\n    const rep={\n"""
insert = """    let expectedAttendance=0,expectedNightAttendance=0;\n    let expectedDailyWage=0,expectedOvertimePay=0,expectedNightWage=0,expectedNightOvertimePay=0,expectedTransportFee=0;\n    records.forEach(r=>{\n      const t=dailyTotal(r,emp);\n      expectedAttendance+=r.attendance||0;\n      expectedNightAttendance+=r.nightAttendance||0;\n      if(t.overridden){\n        expectedDailyWage+=t.total;\n      }else{\n        expectedDailyWage+=t.wage;expectedOvertimePay+=t.ot;expectedNightWage+=t.nwage;\n        expectedNightOvertimePay+=t.not;expectedTransportFee+=t.tr;\n      }\n    });\n    const money=(v,n)=>backupNum(v??0,`${label}の${n}`,0,1000000000000);\n    const rep={\n"""
app = replace_once(app, anchor, insert, 'snapshot expected aggregate insertion')

anchor = """      grandTotal:money(rr.grandTotal,'合計'),\n      records\n    };\n    return {emp,rep};\n"""
insert = """      grandTotal:money(rr.grandTotal,'合計'),\n      records\n    };\n    const expectedRep={\n      totalAttendance:expectedAttendance,totalNightAttendance:expectedNightAttendance,\n      totalDailyWage:expectedDailyWage,totalOvertimePay:expectedOvertimePay,\n      totalNightWage:expectedNightWage,totalNightOvertimePay:expectedNightOvertimePay,\n      totalTransportFee:expectedTransportFee,\n      grandTotal:expectedDailyWage+expectedOvertimePay+expectedNightWage+expectedNightOvertimePay+expectedTransportFee\n    };\n    Object.entries(expectedRep).forEach(([key,value])=>{\n      if(rep[key]!==value)backupFail(`${label}の集計値が勤怠明細と一致しません (${key})`);\n    });\n    return {emp,rep};\n"""
app = replace_once(app, anchor, insert, 'snapshot aggregate comparison')

# 2) Issue-level subtotal/tax/total must agree with the immutable snapshot.
anchor = """  let snapshot=null;\n  if(o.snapshot!=null)snapshot=normalizeBackupSnapshot(o.snapshot,index);\n  return {\n"""
insert = """  let snapshot=null;\n  if(o.snapshot!=null)snapshot=normalizeBackupSnapshot(o.snapshot,index);\n  const subtotal=backupNum(o.subtotal,`発行履歴${index+1}件目の小計`,-1000000000000,1000000000000);\n  const tax=backupNum(o.tax,`発行履歴${index+1}件目の税額`,-1000000000000,1000000000000);\n  const taxRate=backupNum(o.taxRate,`発行履歴${index+1}件目の税率`,0,100);\n  const total=backupNum(o.total,`発行履歴${index+1}件目の合計`,-1000000000000,1000000000000);\n  if(snapshot){\n    const snapSubtotal=snapshot.reports.reduce((sum,x)=>sum+x.rep.grandTotal,0);\n    if(subtotal!==snapSubtotal)backupFail(`発行履歴${index+1}件目の小計がスナップショットと一致しません`);\n    if(taxRate!==snapshot.settings.taxRate)backupFail(`発行履歴${index+1}件目の税率がスナップショットと一致しません`);\n    if(tax!==calcTax(subtotal,taxRate))backupFail(`発行履歴${index+1}件目の税額がスナップショットと一致しません`);\n    if(total!==subtotal+tax)backupFail(`発行履歴${index+1}件目の合計が小計・税額と一致しません`);\n  }\n  return {\n"""
app = replace_once(app, anchor, insert, 'issue consistency variables')

old = """    subtotal:backupNum(o.subtotal,`発行履歴${index+1}件目の小計`,-1000000000000,1000000000000),\n    tax:backupNum(o.tax,`発行履歴${index+1}件目の税額`,-1000000000000,1000000000000),\n    taxRate:backupNum(o.taxRate,`発行履歴${index+1}件目の税率`,0,100),\n    total:backupNum(o.total,`発行履歴${index+1}件目の合計`,-1000000000000,1000000000000),\n"""
new = """    subtotal,tax,taxRate,total,\n"""
app = replace_once(app, old, new, 'issue consistency return fields')

# 3) Cancellation records must reference a real original and exactly reverse its amounts.
anchor = """  const invoiceLog=invoiceRaw.map((x,i)=>{\n    const issue=normalizeBackupIssue(x,i);\n    if(logIds.has(issue.id))backupFail(`発行履歴IDが重複しています: ${issue.id}`);logIds.add(issue.id);\n    return issue;\n  });\n  return {schemaVersion:BACKUP_SCHEMA_VERSION,employees,records,settings:normalizeBackupSettings(o.settings),invoiceLog};\n"""
insert = """  const invoiceLog=invoiceRaw.map((x,i)=>{\n    const issue=normalizeBackupIssue(x,i);\n    if(logIds.has(issue.id))backupFail(`発行履歴IDが重複しています: ${issue.id}`);logIds.add(issue.id);\n    return issue;\n  });\n  const logById=new Map(invoiceLog.map(x=>[x.id,x])),cancelledOriginals=new Set();\n  invoiceLog.forEach((issue,i)=>{\n    if(!issue.voidOf)return;\n    const original=logById.get(issue.voidOf);\n    if(!original)backupFail(`発行履歴${i+1}件目の取消元が見つかりません`);\n    if(original.id===issue.id||original.voidOf)backupFail(`発行履歴${i+1}件目の取消参照が不正です`);\n    if(cancelledOriginals.has(original.id))backupFail(`同じ発行履歴に複数の取消記録があります: ${original.id}`);\n    cancelledOriginals.add(original.id);\n    if(issue.subtotal!==-original.subtotal||issue.tax!==-original.tax||issue.total!==-original.total||issue.taxRate!==original.taxRate){\n      backupFail(`発行履歴${i+1}件目の取消金額が元の発行記録と一致しません`);\n    }\n  });\n  return {schemaVersion:BACKUP_SCHEMA_VERSION,employees,records,settings:normalizeBackupSettings(o.settings),invoiceLog};\n"""
app = replace_once(app, anchor, insert, 'cancellation cross-reference validation')

# 4) If WebKit transient activation expires during a slow IndexedDB write, keep the
# persisted issue and require a second tap rather than silently failing to open print.
anchor = """    toast('発行履歴に記録しました');\n  }\n  // Safari は文書タイトルをPDFの既定ファイル名に使う。検索要件を満たす名前に一時的に差し替える\n"""
insert = """    toast('発行履歴に記録しました');\n  }\n  // WebKitの一時的なユーザー操作状態が、保存待ちの間に失効した場合の保険。\n  // 履歴は既に保存済みなので、印刷だけ次の明示タップに分離する。\n  if(pendingIssue&&navigator.userActivation&&!navigator.userActivation.isActive){\n    if(btn)btn.disabled=false;\n    toast('発行履歴は保存済みです。もう一度「保存・印刷」を押してください');\n    return;\n  }\n  // Safari は文書タイトルをPDFの既定ファイル名に使う。検索要件を満たす名前に一時的に差し替える\n"""
app = replace_once(app, anchor, insert, 'Safari user activation fallback')

# Tests: aggregate mismatch, issue mismatch, cancellation references and Safari fallback.
anchor = """test('validateBackupPayload: 発行スナップショットのID不整合と重複日を拒否する', () => {\n"""
addition = """test('validateBackupPayload: snapshot集計値と発行金額の改ざんを拒否する', () => {\n  const badAggregate = sampleBackup();\n  const snapAggregate = sampleInvoiceSnapshot();\n  snapAggregate.reports[0].rep.grandTotal = 999999;\n  badAggregate.invoiceLog = [sampleIssue(snapAggregate)];\n  assert.throws(() => core.validateBackupPayload(badAggregate), /集計値が勤怠明細と一致/);\n\n  const badIssue = sampleBackup();\n  const issue = sampleIssue(sampleInvoiceSnapshot());\n  issue.subtotal = 999999;\n  badIssue.invoiceLog = [issue];\n  assert.throws(() => core.validateBackupPayload(badIssue), /小計がスナップショットと一致/);\n});\n\ntest('validateBackupPayload: 取消元・取消金額・重複取消の整合性を検証する', () => {\n  const base = sampleIssue(sampleInvoiceSnapshot());\n  const cancellation = {\n    id: 'cancel1', issuedAt: '2026-08-03T00:00:00.000Z', invoiceNo: '2026-000001-取消', issueDate: base.issueDate,\n    period: { ...base.period }, clientName: base.clientName, issuerName: base.issuerName,\n    subtotal: -base.subtotal, tax: -base.tax, taxRate: base.taxRate, total: -base.total,\n    batch: false, voided: true, voidReason: '訂正', voidOperator: '担当者', voidedAt: '2026-08-03T00:00:00.000Z', voidOf: base.id, snapshot: null\n  };\n  const good = sampleBackup(); good.invoiceLog = [base, cancellation];\n  assert.equal(core.validateBackupPayload(good).invoiceLog.length, 2);\n\n  const missing = sampleBackup(); missing.invoiceLog = [{ ...cancellation, voidOf: 'missing_issue' }];\n  assert.throws(() => core.validateBackupPayload(missing), /取消元が見つかりません/);\n\n  const wrongAmount = sampleBackup(); wrongAmount.invoiceLog = [base, { ...cancellation, total: -1 }];\n  assert.throws(() => core.validateBackupPayload(wrongAmount), /取消金額が元の発行記録と一致/);\n\n  const duplicate = sampleBackup(); duplicate.invoiceLog = [base, cancellation, { ...cancellation, id: 'cancel2' }];\n  assert.throws(() => core.validateBackupPayload(duplicate), /複数の取消記録/);\n});\n\n""" + anchor
test = replace_once(test, anchor, addition, 'consistency tests insertion')

old = """  const rollback = handler.indexOf('STATE.invoiceLog.splice(i,1);');\n  assert.ok(save >= 0, 'invoiceLog 保存を await していない');\n  assert.ok(print > save, '保存完了より先に印刷へ進んでいる');\n  assert.ok(rollback > save, '保存失敗時のメモリ上の履歴巻き戻しがない');\n  assert.match(handler, /印刷は開始していません/);\n"""
new = """  const rollback = handler.indexOf('STATE.invoiceLog.splice(i,1);');\n  const activationGuard = handler.indexOf('navigator.userActivation');\n  assert.ok(save >= 0, 'invoiceLog 保存を await していない');\n  assert.ok(print > save, '保存完了より先に印刷へ進んでいる');\n  assert.ok(rollback > save, '保存失敗時のメモリ上の履歴巻き戻しがない');\n  assert.ok(activationGuard > save && activationGuard < print, '保存待ちでユーザー操作状態が失効した場合の印刷フォールバックがない');\n  assert.match(handler, /印刷は開始していません/);\n  assert.match(handler, /発行履歴は保存済みです/);\n"""
test = replace_once(test, old, new, 'Safari fallback test')

APP.write_text(app, encoding='utf-8')
TEST.write_text(test, encoding='utf-8')
print('final gate patch applied')
