from pathlib import Path

APP = Path('app.js')
TEST = Path('tests/core-invariants.test.js')

app = APP.read_text(encoding='utf-8')
old_calc = """function calcTax(sub,rate){return Math.floor(sub*(rate/100));}\n\n/** 期間レポート（従業員1人）*/\n"""
new_calc = """function calcTax(sub,rate){return Math.floor(sub*(rate/100));}\n\n/** 発行済み履歴を基準に、その年の次の請求番号を決める。\n * 旧形式（YYYY-MM-xxx）は過去互換として残し、新形式 YYYY-NNNNNN だけを\n * 連番として数えるため、既存の発行済み番号は一切書き換えない。 */\nfunction nextInvoiceNumber(log,year){\n  let max=0;\n  (Array.isArray(log)?log:[]).forEach(o=>{\n    const s=o&&typeof o.invoiceNo==='string'?o.invoiceNo:'';\n    const m=s.match(/^(\\d{4})-(\\d{6})$/);\n    if(m&&Number(m[1])===Number(year))max=Math.max(max,Number(m[2])||0);\n  });\n  return `${year}-${String(max+1).padStart(6,'0')}`;\n}\n\n/** 期間レポート（従業員1人）*/\n"""
if app.count(old_calc) != 1:
    raise SystemExit(f'ABORT: expected calcTax anchor exactly once, found {app.count(old_calc)}')
app = app.replace(old_calc, new_calc, 1)

old_no = """function invoiceNoOf(reports,batch,y,m){\n  return batch?`${y}-${pad2(m)}-ALL`\n    :`${y}-${pad2(m)}-${(reports[0].emp.id).replace(/[^0-9]/g,'').slice(0,3).padStart(3,'0')||'001'}`;\n}\n"""
new_no = """function invoiceNoOf(reports,batch,y,m){\n  // 個別/一括を同じ年次連番に載せ、同じ月の再発行でも番号が衝突しないようにする。\n  return nextInvoiceNumber(STATE.invoiceLog,y);\n}\n"""
if app.count(old_no) != 1:
    raise SystemExit(f'ABORT: expected invoiceNoOf source exactly once, found {app.count(old_no)}')
app = app.replace(old_no, new_no, 1)
APP.write_text(app, encoding='utf-8')

test_src = TEST.read_text(encoding='utf-8')
old_expose = """    billingPeriod, calcTax, daysInPeriod,\n    periodReport, idx, invalidateIdx, STATE,\n"""
new_expose = """    billingPeriod, calcTax, nextInvoiceNumber, daysInPeriod,\n    periodReport, idx, invalidateIdx, STATE,\n"""
if test_src.count(old_expose) != 1:
    raise SystemExit(f'ABORT: expected core expose anchor exactly once, found {test_src.count(old_expose)}')
test_src = test_src.replace(old_expose, new_expose, 1)

name = "nextInvoiceNumber: 旧形式を壊さず新形式だけを年次連番にする"
if name not in test_src:
    anchor = """test('calcTax: 請求書単位の税計算は切り捨て1回', () => {\n"""
    block = r"""test('nextInvoiceNumber: 旧形式を壊さず新形式だけを年次連番にする', () => {
  assert.equal(core.nextInvoiceNumber([], 2026), '2026-000001');
  const log = [
    { invoiceNo: '2026-08-001' },
    { invoiceNo: '2026-000001' },
    { invoiceNo: '2025-000099' },
    { invoiceNo: '2026-000003' },
    { invoiceNo: '2026-000003-取消' },
    { invoiceNo: '2026-08-ALL' },
  ];
  assert.equal(core.nextInvoiceNumber(log, 2026), '2026-000004');
  assert.equal(core.nextInvoiceNumber(log, 2027), '2027-000001');
});

"""
    if test_src.count(anchor) != 1:
        raise SystemExit(f'ABORT: expected calcTax test anchor exactly once, found {test_src.count(anchor)}')
    test_src = test_src.replace(anchor, block + anchor, 1)
TEST.write_text(test_src, encoding='utf-8')
print('Invoice number sequence applied safely.')
