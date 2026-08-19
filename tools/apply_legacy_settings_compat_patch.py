from pathlib import Path

APP = Path('app.js')
TEST = Path('tests/core-invariants.test.js')
app = APP.read_text(encoding='utf-8')
test = TEST.read_text(encoding='utf-8')

def once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'ABORT {label}: expected exactly once, found {count}')
    return text.replace(old, new, 1)

old = "return {schemaVersion:BACKUP_SCHEMA_VERSION,employees,records,settings:normalizeBackupSettings(o.settings),invoiceLog};"
new = "return {schemaVersion:BACKUP_SCHEMA_VERSION,employees,records,settings:normalizeBackupSettings(o.settings,legacyBackup),invoiceLog};"
app = once(app, old, new, 'legacy top-level settings mode')

anchor = """test('validateBackupPayload: 発行スナップショット内部も数値型まで検証・正規化する', () => {\n"""
block = """test('validateBackupPayload: schemaVersionなしの旧設定値は上限導入前のraw値を保持し、新schemaでは拒否する', () => {\n  const legacy = sampleBackup();\n  legacy.settings.defaultTransportFee = 1000000;\n  legacy.settings.monthlyGoal = 2000000000000;\n  const out = core.validateBackupPayload(legacy);\n  assert.equal(out.settings.defaultTransportFee, 1000000);\n  assert.equal(out.settings.monthlyGoal, 2000000000000);\n\n  const strictTransport = sampleBackup();\n  strictTransport.schemaVersion = 1;\n  strictTransport.settings.defaultTransportFee = 1000000;\n  assert.throws(() => core.validateBackupPayload(strictTransport), /範囲外/);\n\n  const strictGoal = sampleBackup();\n  strictGoal.schemaVersion = 1;\n  strictGoal.settings.monthlyGoal = 2000000000000;\n  assert.throws(() => core.validateBackupPayload(strictGoal), /範囲外/);\n});\n\n""" + anchor
test = once(test, anchor, block, 'legacy settings compatibility test')

APP.write_text(app, encoding='utf-8')
TEST.write_text(test, encoding='utf-8')
print('legacy top-level settings compatibility patch applied')
