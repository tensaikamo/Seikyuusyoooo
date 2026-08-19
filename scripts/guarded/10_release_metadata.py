from pathlib import Path
import json

APP=Path('app.js')
INDEX=Path('index.html')
MANIFEST=Path('manifest.json')
SW=Path('sw.js')
TEST=Path('tests/core-invariants.test.js')


def exact_replace(path, old, new, label):
    src=path.read_text(encoding='utf-8')
    n=src.count(old)
    if n!=1:
        raise SystemExit(f'ABORT: expected {label} exactly once, found {n}')
    path.write_text(src.replace(old,new,1),encoding='utf-8')

exact_replace(APP,"   ネイビー×白 / IndexedDB / A4 2ページPDF\n","   ネイビー×白 / IndexedDB / A4印刷・PDF保存\n",'app header PDF wording')
exact_replace(APP,"const APP_VERSION='1.6.4';","const APP_VERSION='1.7.0';",'APP_VERSION')
exact_replace(APP,"/* A4 2ページ請求書HTML（ネイビー×白・帳票風）\n   cssMode: 'print'(A4原寸) または 'screen'(画面幅フィット) */","/* A4請求書HTML（表紙＋必要枚数の明細 / ネイビー×白・帳票風）\n   cssMode: 'print'(A4原寸) または 'screen'(画面幅フィット) */",'invoice HTML comment')

old_desc='日給制の勤怠管理と請求書発行。インボイス対応・A4 2ページPDF。'
new_desc='日給制の勤怠管理と請求書発行。インボイス対応・A4印刷/PDF保存。'
exact_replace(INDEX,old_desc,new_desc,'index description')
exact_replace(INDEX,'まとめ請求書をPDFで作る','まとめ請求書を保存・印刷','batch invoice button')

manifest=json.loads(MANIFEST.read_text(encoding='utf-8'))
if manifest.get('description')!=old_desc:
    raise SystemExit(f"ABORT: unexpected manifest description: {manifest.get('description')!r}")
manifest['description']=new_desc
MANIFEST.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+"\n",encoding='utf-8')

exact_replace(SW,"const CACHE='invoice-v15';","const CACHE='invoice-v16';",'service worker cache version')

test_src=TEST.read_text(encoding='utf-8')
name="リリース表記は実際の印刷/PDF保存方式と一致する"
if name not in test_src:
    test_src += r'''

test('リリース表記は実際の印刷/PDF保存方式と一致する', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.match(app, /const APP_VERSION='1\.7\.0';/);
  assert.doesNotMatch(app, /A4 2ページPDF/);
  assert.doesNotMatch(html, /A4 2ページPDF/);
  assert.equal(manifest.description.includes('A4 2ページPDF'), false);
  assert.match(html, /まとめ請求書を保存・印刷/);
  assert.match(sw, /const CACHE='invoice-v16';/);
});
'''
TEST.write_text(test_src,encoding='utf-8')
print('Release metadata cleanup applied safely.')
