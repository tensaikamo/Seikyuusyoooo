from pathlib import Path

APP = Path('app.js')
TEST = Path('tests/core-invariants.test.js')

app = APP.read_text(encoding='utf-8')

# Remove claims that the app itself is an immutable/compliant system.
old_comment = """/* ===== PDF ===== */\n/* ---------- 発行（電子帳簿保存法）---------- */\n/* 発行時点の内容をスナップショットとして保存する。あとで勤怠を直しても\n   発行済みの請求書の内容は変わらない（これが電帳法上も正しい挙動）。 */\n"""
new_comment = """/* ===== PDF ===== */\n/* ---------- 発行履歴 ---------- */\n/* 発行時点の内容をスナップショットとして保存する。あとで勤怠を直しても\n   発行済み請求書の再表示内容を変えないための監査補助。\n   法令上の保存要件への適合を、このアプリ単体で保証するものではない。 */\n"""
if app.count(old_comment) != 1:
    raise SystemExit(f'ABORT: expected issue comment once, found {app.count(old_comment)}')
app = app.replace(old_comment, new_comment, 1)
app = app.replace('/* ---------- 発行履歴（電子帳簿保存法）---------- */', '/* ---------- 発行履歴 ---------- */', 1)

# Render cancellation state from either historical mutated entries or new append-only cancellation records.
old_render_head = """  list.innerHTML=STATE.invoiceLog.slice().reverse().map(o=>{\n    const dt=new Date(o.issuedAt);\n    const stamp=`${dt.getFullYear()}/${pad2(dt.getMonth()+1)}/${pad2(dt.getDate())} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;\n    return `<div class=\"log-item${o.voided?' void':''}\">\n"""
new_render_head = """  list.innerHTML=STATE.invoiceLog.slice().reverse().map(o=>{\n    const dt=new Date(o.issuedAt);\n    const stamp=`${dt.getFullYear()}/${pad2(dt.getMonth()+1)}/${pad2(dt.getDate())} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;\n    const cancellation=STATE.invoiceLog.find(x=>x&&x.voidOf===o.id);\n    const isVoided=!!o.voided||!!cancellation;\n    const voidReason=o.voidReason||(cancellation&&cancellation.voidReason)||'';\n    const voidOperator=o.voidOperator||(cancellation&&cancellation.voidOperator)||'';\n    return `<div class=\"log-item${isVoided?' void':''}\">\n"""
if app.count(old_render_head) != 1:
    raise SystemExit(f'ABORT: expected invoice log render head once, found {app.count(old_render_head)}')
app = app.replace(old_render_head, new_render_head, 1)

old_render_body = """        <span class=\"log-no\">No. ${esc(o.invoiceNo)}${o.voided?'<span class=\"log-tag\">取消済</span>':''}</span>\n        <span class=\"log-amt\">${yen(o.total)}</span>\n      </div>\n      <div class=\"log-meta\">${esc(o.clientName)} 御中　／　${esc(o.period.periodLabel)}<br>発行 ${stamp}　${esc(issueFileName(o))}${o.voided&&o.voidReason?'<br>取消理由：'+esc(o.voidReason):''}</div>\n      <div class=\"log-btns\">\n        <button type=\"button\" onclick=\"reopenIssue('${o.id}')\">再表示・再印刷</button>\n        ${o.voided?'':`<button type=\"button\" class=\"danger\" onclick=\"voidIssue('${o.id}')\">取り消す</button>`}\n"""
new_render_body = """        <span class=\"log-no\">No. ${esc(o.invoiceNo)}${isVoided?'<span class=\"log-tag\">取消済</span>':''}</span>\n        <span class=\"log-amt\">${yen(o.total)}</span>\n      </div>\n      <div class=\"log-meta\">${esc(o.clientName)} 御中　／　${esc(o.period.periodLabel)}<br>発行 ${stamp}　${esc(issueFileName(o))}${isVoided&&voidReason?'<br>取消理由：'+esc(voidReason):''}${isVoided&&voidOperator?'<br>取消担当：'+esc(voidOperator):''}</div>\n      <div class=\"log-btns\">\n        <button type=\"button\" onclick=\"reopenIssue('${o.id}')\">再表示・再印刷</button>\n        ${isVoided?'':`<button type=\"button\" class=\"danger\" onclick=\"voidIssue('${o.id}')\">取り消す</button>`}\n"""
if app.count(old_render_body) != 1:
    raise SystemExit(f'ABORT: expected invoice log render body once, found {app.count(old_render_body)}')
app = app.replace(old_render_body, new_render_body, 1)

# Replace mutation-based cancellation with append-only cancellation + awaited persistence.
old_void = """/* 取消は「削除」ではなく取消記録の追記で行う（真実性の確保要件） */\nfunction voidIssue(id){\n  const o=STATE.invoiceLog.find(x=>x.id===id);\n  if(!o||o.voided)return;\n  const reason=prompt('取り消す理由を入力してください（記録として残ります）');\n  if(reason===null)return;\n  o.voided=true;\n  o.voidReason=reason||'（理由未記入）';\n  o.voidedAt=new Date().toISOString();\n  STATE.invoiceLog.push({\n    id:uid(), issuedAt:o.voidedAt, invoiceNo:o.invoiceNo+'-取消',\n    issueDate:o.issueDate, period:o.period,\n    clientName:o.clientName, issuerName:o.issuerName,\n    subtotal:-o.subtotal, tax:-o.tax, taxRate:o.taxRate, total:-o.total,\n    batch:o.batch, voided:true, voidReason:o.voidReason, voidOf:o.id, snapshot:null\n  });\n  saveInvoiceLog();\n  renderInvoiceLog();\n  toast('取消記録を追記しました');\n}\n"""
new_void = """/* 新規の取消は元の発行記録を変更せず、取消記録だけを追記する。\n   旧バージョンで voided=true が付いた履歴も表示上は引き続き認識する。 */\nasync function voidIssue(id){\n  const o=STATE.invoiceLog.find(x=>x.id===id);\n  if(!o||o.voided||STATE.invoiceLog.some(x=>x&&x.voidOf===o.id))return;\n  const reason=prompt('取り消す理由を入力してください（記録として残ります）');\n  if(reason===null)return;\n  const operator=prompt('処理担当者名を入力してください（記録として残ります）');\n  if(operator===null)return;\n  if(!operator.trim()){toast('⚠️ 処理担当者名を入力してください');return;}\n  const voidedAt=new Date().toISOString();\n  const cancellation={\n    id:uid(), issuedAt:voidedAt, invoiceNo:o.invoiceNo+'-取消',\n    issueDate:o.issueDate, period:JSON.parse(JSON.stringify(o.period)),\n    clientName:o.clientName, issuerName:o.issuerName,\n    subtotal:-o.subtotal, tax:-o.tax, taxRate:o.taxRate, total:-o.total,\n    batch:o.batch, voided:true, voidReason:reason||'（理由未記入）',\n    voidOperator:operator.trim(), voidedAt, voidOf:o.id, snapshot:null\n  };\n  STATE.invoiceLog.push(cancellation);\n  try{\n    await saveInvoiceLog();\n  }catch(e){\n    const i=STATE.invoiceLog.lastIndexOf(cancellation);\n    if(i>=0)STATE.invoiceLog.splice(i,1);\n    toast('⚠️ 取消記録を保存できませんでした。取消は成立していません');\n    return;\n  }\n  renderInvoiceLog();\n  toast('取消記録を追記しました');\n}\n"""
if app.count(old_void) != 1:
    raise SystemExit(f'ABORT: expected voidIssue block once, found {app.count(old_void)}')
app = app.replace(old_void, new_void, 1)

# Preserve the new operator field when restoring backups.
old_norm = """    batch:!!o.batch,voided:!!o.voided,voidReason:backupText(o.voidReason,`発行履歴${index+1}件目の取消理由`,1000),\n    ...(o.voidedAt?{voidedAt:backupText(o.voidedAt,`発行履歴${index+1}件目の取消日時`,80)}:{}),\n"""
new_norm = """    batch:!!o.batch,voided:!!o.voided,voidReason:backupText(o.voidReason,`発行履歴${index+1}件目の取消理由`,1000),\n    ...(o.voidOperator?{voidOperator:backupText(o.voidOperator,`発行履歴${index+1}件目の取消担当者`,200)}:{}),\n    ...(o.voidedAt?{voidedAt:backupText(o.voidedAt,`発行履歴${index+1}件目の取消日時`,80)}:{}),\n"""
if app.count(old_norm) != 1:
    raise SystemExit(f'ABORT: expected invoice log normalizer anchor once, found {app.count(old_norm)}')
app = app.replace(old_norm, new_norm, 1)

# Make the generated rule operationally truthful instead of saying the app cannot delete data.
old_rule_head = """第1条　この規程は、電子計算機を使用して作成する国税関係帳簿書類の保存方法の\n特例に関する法律第7条に定められた電子取引の取引情報に係る電磁的記録の保存\n義務を履行するため、${name}（以下「当方」という。）における電子取引の取引\n"""
new_rule_head = """第1条　この規程は、電子帳簿保存法に定められた電子取引の取引情報に係る\n電磁的記録の保存義務を履行するため、${name}（以下「当方」という。）における電子取引の取引\n"""
if app.count(old_rule_head) != 1:
    raise SystemExit(f'ABORT: expected rule purpose once, found {app.count(old_rule_head)}')
app = app.replace(old_rule_head, new_rule_head, 1)

old_manager = """（管理責任者）\n第3条　電子取引の取引情報に係る電磁的記録の管理責任者は、${name}の代表者と\nする。\n"""
new_manager = """（管理責任者及び処理責任者）\n第3条　電子取引の取引情報に係る電磁的記録の管理責任者は、${name}の代表者と\nする。処理責任者は、管理責任者が事前に指名した者とする。\n"""
if app.count(old_manager) != 1:
    raise SystemExit(f'ABORT: expected manager clause once, found {app.count(old_manager)}')
app = app.replace(old_manager, new_manager, 1)

old_article7 = """（訂正削除を行う場合）\n第7条　業務処理上やむを得ない理由により訂正又は削除を行う場合は、管理責任者\nの承認を得たうえで、訂正又は削除の年月日、理由及び内容を記録として残し、\n当該記録を取引データと合わせて保存する。取消しを行う場合は、元の記録を\n削除せず、取消しの記録を追加することにより行う。\n\n（備考）\n本規程で定める記録は、当方が使用する「日給管理・請求書」アプリの発行履歴\n機能により、発行時点の内容のまま保存され、削除できない形で管理される。\n"""
new_article7 = """（訂正削除を行う場合）\n第7条　業務処理上やむを得ない理由により訂正又は削除を行う場合は、管理責任者\nの承認を得たうえで、訂正又は削除の年月日、理由、内容及び処理担当者の氏名を\n記録として残し、当該記録を取引データと合わせて保存する。取消しを行う場合は、\n元の記録を削除せず、取消しの記録を追加することにより行う。\n\n（本アプリの位置付け）\n第8条　「日給管理・請求書」アプリは、発行時点のスナップショット及び取消記録を\n保存するための運用補助機能として使用する。本アプリにはバックアップ復元及び\n全データ削除の機能があるため、本アプリ単体を「訂正削除ができないシステム」と\nして扱わない。これらの機能により保存対象データを訂正又は削除する場合は、\n管理責任者の承認を得て、実施年月日、理由、内容及び処理担当者を別途記録し、\n保存する。法令上必要となる保存期間、検索性その他の要件は、本規程に沿って\n当方の責任で運用する。\n"""
if app.count(old_article7) != 1:
    raise SystemExit(f'ABORT: expected rule article 7/remark once, found {app.count(old_article7)}')
app = app.replace(old_article7, new_article7, 1)
APP.write_text(app, encoding='utf-8')

# Regression checks: source must not mutate original issue in new void path and must await persistence.
test_src = TEST.read_text(encoding='utf-8')
name = "取消は元の発行記録を変更せず追記保存する"
if name not in test_src:
    test_src += r"""

test('取消は元の発行記録を変更せず追記保存する', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const start = src.indexOf('async function voidIssue(id){');
  assert.notEqual(start, -1);
  const end = src.indexOf('\nwindow.voidIssue=voidIssue;', start);
  const body = src.slice(start, end);
  assert.doesNotMatch(body, /o\.voided\s*=\s*true/);
  assert.doesNotMatch(body, /o\.voidReason\s*=/);
  assert.match(body, /voidOperator:operator\.trim\(\)/);
  assert.match(body, /STATE\.invoiceLog\.push\(cancellation\)/);
  assert.match(body, /await saveInvoiceLog\(\)/);
  assert.match(body, /取消は成立していません/);
});

test('事務処理規程はアプリを削除不能システムと誤表現しない', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const start = src.indexOf("$('rule-btn').addEventListener('click',()=>{");
  const end = src.indexOf('/* データ管理 */', start);
  const body = src.slice(start, end);
  assert.match(body, /処理担当者/);
  assert.match(body, /本アプリ単体を「訂正削除ができないシステム」と/);
  assert.doesNotMatch(body, /削除できない形で管理される/);
});
"""
TEST.write_text(test_src, encoding='utf-8')
print('Append-only cancellation and truthful compliance wording applied safely.')
