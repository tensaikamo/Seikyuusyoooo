from pathlib import Path

APP = Path('app.js')
TEST = Path('tests/core-invariants.test.js')

app = APP.read_text(encoding='utf-8')
old = """    let py=year,pm=month-1; if(pm===0){pm=12;py=year-1;}\n    const prevLast=new Date(py,pm,0).getDate();\n    const sd=Math.min(closingDay+1,prevLast);\n    start=new Date(py,pm-1,sd);\n    const curLast=new Date(year,month,0).getDate();\n"""
new = """    let py=year,pm=month-1; if(pm===0){pm=12;py=year-1;}\n    const prevLast=new Date(py,pm,0).getDate();\n    // 前月の実在する締め日を確定してから、その翌日を開始日にする。\n    // 28日締め + 2月のように closingDay+1 が存在しない月でも、\n    // 前月末日を重複計上せず翌月1日へ正しく繰り上がる。\n    const prevClose=new Date(py,pm-1,Math.min(closingDay,prevLast));\n    start=new Date(prevClose);\n    start.setDate(start.getDate()+1);\n    const curLast=new Date(year,month,0).getDate();\n"""

if app.count(old) != 1:
    raise SystemExit(f'ABORT: expected billingPeriod source block exactly once, found {app.count(old)}')
app = app.replace(old, new, 1)
APP.write_text(app, encoding='utf-8')

test_src = TEST.read_text(encoding='utf-8')
old_test = """test('billingPeriod: 28日締めで2月末日を前月と二重計上しない', {\n  todo: 'Phase 1: 現行 v1.6.4 の既知バグ。前月締め日の翌日を Date 加算で求める修正後に todo を外す。'\n}, () => {\n"""
new_test = """test('billingPeriod: 28日締めで2月末日を前月と二重計上しない', () => {\n"""
if test_src.count(old_test) != 1:
    raise SystemExit(f'ABORT: expected 28-day TODO test exactly once, found {test_src.count(old_test)}')
test_src = test_src.replace(old_test, new_test, 1)

anchor = """test('periodReport: 同一従業員・同一日の重複レコードを二重請求しない', {\n"""
property_test = r"""
test('billingPeriod: 1〜28日締めは月をまたいでも空白・重複がない', () => {
  const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  for (let closing = 1; closing <= 28; closing++) {
    for (let y = 2024; y <= 2030; y++) {
      for (let m = 1; m <= 12; m++) {
        const cur = core.billingPeriod(y, m, closing);
        const nextDate = new Date(y, m, 1);
        const next = core.billingPeriod(nextDate.getFullYear(), nextDate.getMonth()+1, closing);
        const dayAfterEnd = new Date(cur.end + 'T00:00:00');
        dayAfterEnd.setDate(dayAfterEnd.getDate()+1);
        assert.equal(
          next.start,
          iso(dayAfterEnd),
          `closing=${closing}, period=${y}-${String(m).padStart(2,'0')}`
        );
      }
    }
  }
});

"""
if test_src.count(anchor) != 1:
    raise SystemExit(f'ABORT: expected duplicate-record test anchor exactly once, found {test_src.count(anchor)}')
if "billingPeriod: 1〜28日締めは月をまたいでも空白・重複がない" not in test_src:
    test_src = test_src.replace(anchor, property_test + anchor, 1)

TEST.write_text(test_src, encoding='utf-8')
print('Phase 1 billing patch applied safely.')
