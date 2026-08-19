from pathlib import Path

APP=Path('app.js')
TEST=Path('tests/core-invariants.test.js')
app=APP.read_text(encoding='utf-8')
test=TEST.read_text(encoding='utf-8')

def once(text,old,new,label):
    n=text.count(old)
    if n!=1: raise SystemExit(f'ABORT {label}: expected once, found {n}')
    return text.replace(old,new,1)

app=once(app,"function normalizeBackupSettings(raw){","function normalizeBackupSettings(raw,legacy=false){",'settings signature')
app=once(app,"  if(![0,8,10].includes(tax))backupFail('消費税率は 0・8・10% のいずれかにしてください');","  if(!legacy&&![0,8,10].includes(tax))backupFail('消費税率は 0・8・10% のいずれかにしてください');",'legacy tax compatibility')
app=once(app,"    defaultTransportFee:backupNum(s.defaultTransportFee??DEFAULT_SETTINGS.defaultTransportFee,'車代の初期値',0,INPUT_MAX.transportFee),","    defaultTransportFee:backupNum(s.defaultTransportFee??DEFAULT_SETTINGS.defaultTransportFee,'車代の初期値',0,legacy?Number.MAX_SAFE_INTEGER:INPUT_MAX.transportFee),",'legacy transport setting bound')
app=once(app,"    monthlyGoal:backupNum(s.monthlyGoal??DEFAULT_SETTINGS.monthlyGoal,'月間目標',0,1000000000000),","    monthlyGoal:backupNum(s.monthlyGoal??DEFAULT_SETTINGS.monthlyGoal,'月間目標',0,legacy?Number.MAX_SAFE_INTEGER:1000000000000),",'legacy monthly goal bound')
app=once(app,"  const settings=normalizeBackupSettings(s.settings);","  const settings=normalizeBackupSettings(s.settings,legacy);",'snapshot legacy settings call')

app=once(app,"  invoiceLog:[],     // 発行履歴（電子帳簿保存法）。追記のみ・削除しない","  invoiceLog:[],     // 発行履歴。新規取消は元記録を変更せず取消レコードを追記（全データ削除/復元は別機能）",'invoice log comment')
app=once(app,"  // Safari は文書タイトルをPDFの既定ファイル名に使う。検索要件を満たす名前に一時的に差し替える","  // Safari は文書タイトルをPDFの既定ファイル名に使う。識別しやすい名前に一時的に差し替える",'print filename comment')

anchor="""test('validateBackupPayload: 旧発行snapshotの過去上限超過値は履歴として保持し、新schemaでは拒否する', () => {\n"""
block="""test('validateBackupPayload: 旧発行snapshot内の過去設定値は証跡として保持し、新schemaでは現行上限を適用する', () => {\n  const legacy = sampleBackup();\n  const snap = sampleInvoiceSnapshot();\n  snap.settings.defaultTransportFee = 250000;\n  const issue = sampleIssue(snap);\n  legacy.invoiceLog = [issue];\n  assert.doesNotThrow(() => core.validateBackupPayload(legacy));\n\n  const strict = sampleBackup(); strict.schemaVersion = 1; strict.invoiceLog = [issue];\n  assert.throws(() => core.validateBackupPayload(strict), /車代の初期値.*範囲外/);\n});\n\n"""+anchor
test=once(test,anchor,block,'legacy settings compatibility test')

APP.write_text(app,encoding='utf-8')
TEST.write_text(test,encoding='utf-8')
print('final legacy settings patch applied')
