from pathlib import Path

APP = Path('app.js')
TEST = Path('tests/core-invariants.test.js')

app = APP.read_text(encoding='utf-8')
old = """$('pv-print').addEventListener('click',()=>{\n  if(pendingIssue&&!pendingLogged){\n    STATE.invoiceLog.push(pendingIssue);\n    saveInvoiceLog();\n    pendingLogged=true;\n    renderInvoiceLog();\n    stampSeal();\n    toast('発行履歴に記録しました');\n  }\n  // Safari は文書タイトルをPDFの既定ファイル名に使う。検索要件を満たす名前に一時的に差し替える\n  const prevTitle=document.title;\n  if(pendingIssue)document.title=issueFileName(pendingIssue);\n  setTimeout(()=>{\n    window.print();\n    setTimeout(()=>{document.title=prevTitle;},1000);\n  },60);\n});\n"""
new = """$('pv-print').addEventListener('click',async()=>{\n  const btn=$('pv-print');\n  if(btn&&btn.disabled)return;\n  if(btn)btn.disabled=true;\n  if(pendingIssue&&!pendingLogged){\n    STATE.invoiceLog.push(pendingIssue);\n    try{\n      // 発行履歴の永続化が完了してから印刷へ進む。保存失敗時は\n      // 「発行したのに履歴がない」状態を作らない。\n      await saveInvoiceLog();\n    }catch(e){\n      const i=STATE.invoiceLog.lastIndexOf(pendingIssue);\n      if(i>=0)STATE.invoiceLog.splice(i,1);\n      if(btn)btn.disabled=false;\n      toast('⚠️ 発行履歴を保存できませんでした。印刷は開始していません');\n      return;\n    }\n    pendingLogged=true;\n    renderInvoiceLog();\n    stampSeal();\n    toast('発行履歴に記録しました');\n  }\n  // Safari は文書タイトルをPDFの既定ファイル名に使う。検索要件を満たす名前に一時的に差し替える\n  const prevTitle=document.title;\n  if(pendingIssue)document.title=issueFileName(pendingIssue);\n  setTimeout(()=>{\n    try{window.print();}\n    finally{\n      setTimeout(()=>{\n        document.title=prevTitle;\n        if(btn)btn.disabled=false;\n      },1000);\n    }\n  },60);\n});\n"""
if app.count(old) != 1:
    raise SystemExit(f'ABORT: expected print handler exactly once, found {app.count(old)}')
app = app.replace(old, new, 1)
APP.write_text(app, encoding='utf-8')

test_src = TEST.read_text(encoding='utf-8')
name = "発行履歴の永続化完了後にだけ印刷へ進む"
if name not in test_src:
    test_src += r"""

test('発行履歴の永続化完了後にだけ印刷へ進む', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const start = src.indexOf("$('pv-print').addEventListener('click',async()=>{");
  assert.notEqual(start, -1, '印刷ハンドラが async ではない');
  const end = src.indexOf("\n});", start);
  assert.notEqual(end, -1, '印刷ハンドラ終端が見つからない');
  const handler = src.slice(start, end);
  const save = handler.indexOf('await saveInvoiceLog();');
  const print = handler.indexOf('window.print();');
  const rollback = handler.indexOf('STATE.invoiceLog.splice(i,1);');
  assert.ok(save >= 0, 'invoiceLog 保存を await していない');
  assert.ok(print > save, '保存完了より先に印刷へ進んでいる');
  assert.ok(rollback > save, '保存失敗時のメモリ上の履歴巻き戻しがない');
  assert.match(handler, /印刷は開始していません/);
});
"""
TEST.write_text(test_src, encoding='utf-8')
print('Persist-before-print defense applied safely.')
