from pathlib import Path

APP = Path('app.js')
TEST = Path('tests/core-invariants.test.js')

app = APP.read_text(encoding='utf-8')
old = """function periodReport(emp,start,end){\n  const recs=(idx().byEmp.get(emp.id)||[]).filter(r=>r.date>=start&&r.date<=end&&recHasData(r));\n  let att=0,natt=0,wage=0,ot=0,nwage=0,not=0,tr=0;\n"""
new = """function periodReport(emp,start,end){\n  // 同一従業員・同一日の重複レコードは1日1件として扱う。\n  // 通常UIでは重複を作らないが、旧バックアップ等に重複が混ざっても\n  // 請求額を二重計上しないための最終防御。画面表示と同じく後勝ちにする。\n  const recMap=new Map();\n  (idx().byEmp.get(emp.id)||[])\n    .filter(r=>r.date>=start&&r.date<=end&&recHasData(r))\n    .forEach(r=>recMap.set(r.date,r));\n  const recs=[...recMap.values()];\n  let att=0,natt=0,wage=0,ot=0,nwage=0,not=0,tr=0;\n"""
if app.count(old) != 1:
    raise SystemExit(f'ABORT: expected periodReport source block exactly once, found {app.count(old)}')
app = app.replace(old, new, 1)
APP.write_text(app, encoding='utf-8')

test_src = TEST.read_text(encoding='utf-8')
old_test = """test('periodReport: 同一従業員・同一日の重複レコードを二重請求しない', {\n  todo: 'Phase 1/2: 復元時の重複拒否 + 集計側の防御を実装後に todo を外す。'\n}, () => {\n"""
new_test = """test('periodReport: 同一従業員・同一日の重複レコードを二重請求しない', () => {\n"""
if test_src.count(old_test) != 1:
    raise SystemExit(f'ABORT: expected duplicate-record TODO test exactly once, found {test_src.count(old_test)}')
test_src = test_src.replace(old_test, new_test, 1)
TEST.write_text(test_src, encoding='utf-8')
print('Duplicate-record billing defense applied safely.')
