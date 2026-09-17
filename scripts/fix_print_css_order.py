from pathlib import Path

p=Path('app.js')
s=p.read_text(encoding='utf-8')
start=s.find('#print-root .inv-detail-page,\n#print-root .inv-pay-slip-page{')
end_marker='#print-root .inv-detail-page .inv-p1-foot{bottom:5mm;left:14mm;right:14mm;}\n'
end=s.find(end_marker,start)
if start<0 or end<0:
    raise SystemExit('special print CSS block not found')
end+=len(end_marker)
block=s[start:end]
s=s[:start]+s[end:]
page=s.find('@page{size:A4;margin:0;}')
if page<0:
    raise SystemExit('@page anchor not found')
comment='/* A4専用の密度調整は共通テーブル規則より後ろに置く。同一specificityの上書きを防ぐ。 */\n'
s=s[:page]+comment+block+s[page:]
p.write_text(s,encoding='utf-8')

test=r'''"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');

test('A4専用の表密度CSSは共通表CSSより後に置かれ実際に上書きできる',()=>{
  const commonHead=src.indexOf('#print-root .inv-page table.inv-detail thead th');
  const commonCell=src.indexOf('#print-root .inv-page table.inv-detail tbody td');
  const payHead=src.indexOf('#print-root .inv-pay-slip-page table.inv-pay-slip-detail thead th');
  const payCell=src.indexOf('#print-root .inv-pay-slip-page table.inv-pay-slip-detail tbody td');
  const detailHead=src.indexOf('#print-root .inv-detail-page table.inv-detail thead th');
  const detailCell=src.indexOf('#print-root .inv-detail-page table.inv-detail tbody td');
  for(const n of [commonHead,commonCell,payHead,payCell,detailHead,detailCell])assert.ok(n>=0);
  assert.ok(payHead>commonHead&&payCell>commonCell,'支払明細の圧縮CSSが共通規則より前にある');
  assert.ok(detailHead>commonHead&&detailCell>commonCell,'出面内訳の圧縮CSSが共通規則より前にある');
});
'''
Path('tests/print-css-order.test.js').write_text(test,encoding='utf-8')

for tmp in [Path('scripts/fix_print_css_order.py'),Path('.github/workflows/fix-print-css-order.yml')]:
    if tmp.exists():tmp.unlink()
