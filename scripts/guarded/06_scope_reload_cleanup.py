from pathlib import Path

APP = Path('app.js')
TEST = Path('tests/core-invariants.test.js')

app = APP.read_text(encoding='utf-8')
old = """  try{\n    if('caches'in window){const ks=await caches.keys();await Promise.all(ks.map(k=>caches.delete(k)));}\n    if('serviceWorker'in navigator){\n      const rs=await navigator.serviceWorker.getRegistrations();\n      await Promise.all(rs.map(r=>r.unregister()));\n    }\n  }catch(e){}\n"""
new = """  try{\n    // 同一origin上の別PWAを巻き込まない。当アプリが作る invoice-* だけを消す。\n    if('caches'in window){\n      const ks=await caches.keys();\n      await Promise.all(ks.filter(k=>k.startsWith('invoice-')).map(k=>caches.delete(k)));\n    }\n    if('serviceWorker'in navigator){\n      // 現在のページを支配しているregistrationだけを解除する。\n      const reg=await navigator.serviceWorker.getRegistration();\n      if(reg)await reg.unregister();\n    }\n  }catch(e){}\n"""
if app.count(old) != 1:
    raise SystemExit(f'ABORT: expected reload cleanup block once, found {app.count(old)}')
app = app.replace(old, new, 1)
APP.write_text(app, encoding='utf-8')

test_src = TEST.read_text(encoding='utf-8')
name = "最新更新は当アプリのcacheとservice workerだけを対象にする"
if name not in test_src:
    test_src += r"""

test('最新更新は当アプリのcacheとservice workerだけを対象にする', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const start = src.indexOf("$('reload-btn').addEventListener('click',async()=>{");
  assert.notEqual(start, -1);
  const body = src.slice(start, src.indexOf('\nbindSettings();', start));
  assert.match(body, /filter\(k=>k\.startsWith\('invoice-'\)\)/);
  assert.match(body, /navigator\.serviceWorker\.getRegistration\(\)/);
  assert.doesNotMatch(body, /getRegistrations\(\)/);
  assert.doesNotMatch(body, /Promise\.all\(ks\.map\(k=>caches\.delete\(k\)\)\)/);
});
"""
TEST.write_text(test_src, encoding='utf-8')
print('Scoped PWA refresh cleanup applied safely.')
