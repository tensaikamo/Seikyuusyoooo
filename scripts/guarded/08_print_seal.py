from pathlib import Path

APP = Path('app.js')
TEST = Path('tests/core-invariants.test.js')

app = APP.read_text(encoding='utf-8')

old_vars = """  const issuer=s.issuer,client=s.client,bank=s.bank;\n\n  // ---- 1ページ目 ----\n"""
new_vars = """  const issuer=s.issuer,client=s.client,bank=s.bank;\n  // 画面側の角印は発行時アニメーションで表示する。印刷側にはHTML生成時点で\n  // 同じ印影を埋め込み、プレビューだけに印が出る不一致をなくす。\n  const printSeal=(cssMode==='print'&&issuer.companyName)?`<div class=\"inv-doc-seal\">${buildSeal(issuer.companyName)}</div>`:'';\n\n  // ---- 1ページ目 ----\n"""
if app.count(old_vars) != 1:
    raise SystemExit(f'ABORT: expected invoice variable anchor once, found {app.count(old_vars)}')
app = app.replace(old_vars, new_vars, 1)

old_issuer = """          <div class=\"inv-p1-issuer-detail\">\n            ${issuer.postalCode?'〒'+esc(issuer.postalCode)+'<br>':''}\n            ${esc(issuer.address||'')}${issuer.address?'<br>':''}\n            ${issuer.phone?'TEL：'+esc(issuer.phone)+'<br>':''}\n            ${issuer.invoiceNumber?'登録番号：'+esc(issuer.invoiceNumber):''}\n          </div>\n        </div>\n"""
new_issuer = """          <div class=\"inv-p1-issuer-detail\">\n            ${issuer.postalCode?'〒'+esc(issuer.postalCode)+'<br>':''}\n            ${esc(issuer.address||'')}${issuer.address?'<br>':''}\n            ${issuer.phone?'TEL：'+esc(issuer.phone)+'<br>':''}\n            ${issuer.invoiceNumber?'登録番号：'+esc(issuer.invoiceNumber):''}\n          </div>\n          ${printSeal}\n        </div>\n"""
if app.count(old_issuer) != 1:
    raise SystemExit(f'ABORT: expected issuer HTML block once, found {app.count(old_issuer)}')
app = app.replace(old_issuer, new_issuer, 1)

old_css = """#print-root .inv-p1-issuer{text-align:right;font-family:'Hiragino Kaku Gothic ProN',sans-serif;}\n#print-root .inv-p1-issuer-name{font-size:11.5pt;color:#1a2744;font-weight:700;}\n#print-root .inv-p1-issuer-detail{font-size:7.5pt;color:#777;line-height:1.7;margin-top:1.5mm;}\n"""
new_css = """#print-root .inv-p1-issuer{text-align:right;font-family:'Hiragino Kaku Gothic ProN',sans-serif;position:relative;padding-right:24mm;min-height:22mm;}\n#print-root .inv-p1-issuer-name{font-size:11.5pt;color:#1a2744;font-weight:700;}\n#print-root .inv-p1-issuer-detail{font-size:7.5pt;color:#777;line-height:1.7;margin-top:1.5mm;}\n#print-root .inv-doc-seal{position:absolute;right:0;top:-1mm;width:20mm;height:20mm;opacity:.78;mix-blend-mode:multiply;}\n#print-root .inv-doc-seal .seal{display:block;width:100%;height:100%;}\n"""
if app.count(old_css) != 1:
    raise SystemExit(f'ABORT: expected print issuer CSS once, found {app.count(old_css)}')
app = app.replace(old_css, new_css, 1)
APP.write_text(app, encoding='utf-8')

test_src = TEST.read_text(encoding='utf-8')
name = "角印は印刷HTMLにも埋め込まれる"
if name not in test_src:
    test_src += r"""

test('角印は印刷HTMLにも埋め込まれる', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(src, /const printSeal=\(cssMode==='print'&&issuer\.companyName\)/);
  assert.match(src, /\$\{printSeal\}/);
  assert.match(src, /#print-root \.inv-doc-seal\{/);
  assert.match(src, /#print-root \.inv-doc-seal \.seal\{/);
});
"""
TEST.write_text(test_src, encoding='utf-8')
print('Printed invoice seal applied safely.')
