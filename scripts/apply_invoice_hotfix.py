from pathlib import Path

APP = Path('app.js')
text = APP.read_text(encoding='utf-8')


def replace_once(src, old, new, label):
    n = src.count(old)
    if n != 1:
        raise SystemExit(f'{label}: expected 1 match, got {n}')
    return src.replace(old, new, 1)


def replace_once_after(src, anchor, old, new, label):
    a = src.find(anchor)
    if a < 0:
        raise SystemExit(f'{label}: anchor missing')
    p = src.find(old, a)
    if p < 0:
        raise SystemExit(f'{label}: target missing after anchor')
    return src[:p] + new + src[p + len(old):]


# 1) 支払明細は最大31日でもA4 1枚に収める専用クラスを持たせる。
text = replace_once_after(
    text,
    'function buildPaySlipHTML(emp,rep,period,cssMode){',
    'return `<style>${css}</style><div class="inv-page">\n    <div class="inv-topbar"></div>\n    <div class="inv-inner">',
    'return `<style>${css}</style><div class="inv-page inv-pay-slip-page">\n    <div class="inv-topbar"></div>\n    <div class="inv-inner inv-pay-slip-inner">',
    'pay-slip page class',
)
text = replace_once_after(
    text,
    'function buildPaySlipHTML(emp,rep,period,cssMode){',
    '<table class="inv-detail">',
    '<table class="inv-detail inv-pay-slip-detail">',
    'pay-slip table class',
)

# 2) 自動生成角印から会社名を完全に外し、実印を押すための空欄だけにする。
seal_start = text.find('function buildSeal(name){')
seal_end = text.find('/* 発行の瞬間に角印を押す */', seal_start)
if seal_start < 0 or seal_end < 0:
    raise SystemExit('seal function bounds missing')
new_seal = '''function buildSeal(){
  // 会社名を印影として自動生成しない。紙/PDFには実際の判子を押すための空欄だけ残す。
  return `<svg class="seal" viewBox="0 0 100 100" aria-label="押印欄">
    <rect x="4" y="4" width="92" height="92" rx="5" fill="rgba(255,255,255,.22)"
      stroke="#b8bec8" stroke-width="2" stroke-dasharray="7 5"/>
  </svg>`;
}
'''
text = text[:seal_start] + new_seal + text[seal_end:]

# 3) guard() は保存失敗を false で返すので、その真偽値まで発行成立条件として確認する。
close_line = "$('pv-close').addEventListener('click',()=>{$('pv-overlay').classList.remove('show');pendingIssue=null;});\n"
if close_line not in text:
    raise SystemExit('preview close anchor missing')
persist_helper = '''async function persistInvoiceIssue(issue,saveFn=saveInvoiceLog){
  STATE.invoiceLog.push(issue);
  let saved=false;
  try{saved=await saveFn();}catch(e){saved=false;}
  if(saved)return true;
  const i=STATE.invoiceLog.lastIndexOf(issue);
  if(i>=0)STATE.invoiceLog.splice(i,1);
  return false;
}
'''
text = text.replace(close_line, close_line + persist_helper, 1)

old_issue_block = '''  if(pendingIssue&&!pendingLogged){
    const issue=pendingIssue;
    STATE.invoiceLog.push(issue);
    try{
      // 履歴の保存完了を「発行」の成立条件にする。
      await saveInvoiceLog();
    }catch(e){
      const i=STATE.invoiceLog.lastIndexOf(issue);
      if(i>=0)STATE.invoiceLog.splice(i,1);
      if(btn)btn.disabled=false;
      toast('⚠️ 発行履歴を保存できませんでした。印刷は開始していません');
      return;
    }
    pendingLogged=true;
'''
new_issue_block = '''  if(pendingIssue&&!pendingLogged){
    const issue=pendingIssue;
    // guard() は失敗時に例外ではなく false を返す。戻り値まで確認し、
    // 永続化できなかった発行を履歴済み・印刷可能として扱わない。
    const saved=await persistInvoiceIssue(issue);
    if(!saved){
      if(btn)btn.disabled=false;
      toast('⚠️ 発行履歴を保存できませんでした。印刷は開始していません');
      return;
    }
    pendingLogged=true;
'''
text = replace_once(text, old_issue_block, new_issue_block, 'durable issue logging')

# 4) 出面内訳の論理ページを物理A4 1枚に固定する。23行分割との組合せで溢れを防ぐ。
text = replace_once_after(
    text,
    'const detailPages=detailSheets.map((sheet,idx)=>{',
    'return `<div class="inv-page">',
    'return `<div class="inv-page inv-detail-page">',
    'detail page class',
)

css_anchor = "#print-root .inv-page:last-child{page-break-after:auto;}\n"
css_extra = '''#print-root .inv-detail-page,
#print-root .inv-pay-slip-page{height:297mm;min-height:297mm;overflow:hidden;}
/* 支払明細は1日1行なので、31日＋合計行までA4 1枚で読める密度にする。 */
#print-root .inv-pay-slip-page .inv-topbar{height:4mm;}
#print-root .inv-pay-slip-page .inv-inner{padding:9mm 12mm 15mm;}
#print-root .inv-pay-slip-page .inv-p1-top{margin-bottom:4mm;}
#print-root .inv-pay-slip-page .inv-p1-title{font-size:22pt;letter-spacing:8px;}
#print-root .inv-pay-slip-page .inv-title-en{font-size:6.5pt;margin-top:1mm;}
#print-root .inv-pay-slip-page .inv-p1-meta{font-size:7.5pt;line-height:1.55;}
#print-root .inv-pay-slip-page .inv-parties{margin-bottom:4mm;}
#print-root .inv-pay-slip-page .inv-client-name{font-size:12pt;padding-bottom:1.5mm;}
#print-root .inv-pay-slip-page .inv-p1-issuer{min-height:16mm;}
#print-root .inv-pay-slip-page .inv-amount-row{padding:3mm 1mm;margin-bottom:4mm;}
#print-root .inv-pay-slip-page .inv-total-amount{font-size:21pt;}
#print-root .inv-pay-slip-page .inv-subject{font-size:8pt;margin-bottom:3mm;}
#print-root .inv-pay-slip-page table.inv-pay-slip-detail{margin-bottom:2mm;}
#print-root .inv-pay-slip-page table.inv-pay-slip-detail thead th{font-size:7pt;padding:0 1.5mm 1mm;}
#print-root .inv-pay-slip-page table.inv-pay-slip-detail tbody td{font-size:7.2pt;line-height:1.15;padding:.85mm 1.5mm;}
#print-root .inv-pay-slip-page .inv-detail .inv-total-row td{font-size:7.5pt;padding-top:1.2mm;}
#print-root .inv-pay-slip-page .inv-p1-foot{bottom:5mm;left:12mm;right:12mm;}
'''
if css_anchor not in text:
    raise SystemExit('print css anchor missing')
text = text.replace(css_anchor, css_anchor + css_extra, 1)

APP.write_text(text, encoding='utf-8')

# 独立した回帰テスト。既存テストの「文字列の順序確認」だけでは保存失敗を拾えなかったため、
# persistInvoiceIssue は実際に false / throw / true を与えて状態まで確認する。
test = r'''\
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function extractFunction(name) {
  const needles = [`async function ${name}(`, `function ${name}(`];
  let start = -1;
  for (const n of needles) { start = source.indexOf(n); if (start >= 0) break; }
  assert.ok(start >= 0, `${name} not found`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} has no closing brace`);
}

test('発行履歴の永続化がfalseなら履歴を巻き戻して発行不成立にする', async () => {
  const ctx = { STATE: { invoiceLog: [] }, saveInvoiceLog: async () => true };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(extractFunction('persistInvoiceIssue') + ';globalThis.fn=persistInvoiceIssue;', ctx);
  const issue = { id: 'issue-fail' };
  assert.equal(await ctx.fn(issue, async () => false), false);
  assert.equal(ctx.STATE.invoiceLog.length, 0);
});

test('発行履歴の保存関数がthrowしても履歴を巻き戻す', async () => {
  const ctx = { STATE: { invoiceLog: [] }, saveInvoiceLog: async () => true };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(extractFunction('persistInvoiceIssue') + ';globalThis.fn=persistInvoiceIssue;', ctx);
  const issue = { id: 'issue-throw' };
  assert.equal(await ctx.fn(issue, async () => { throw new Error('quota'); }), false);
  assert.equal(ctx.STATE.invoiceLog.length, 0);
});

test('発行履歴が永続化できた場合だけ履歴を残す', async () => {
  const ctx = { STATE: { invoiceLog: [] }, saveInvoiceLog: async () => true };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(extractFunction('persistInvoiceIssue') + ';globalThis.fn=persistInvoiceIssue;', ctx);
  const issue = { id: 'issue-ok' };
  assert.equal(await ctx.fn(issue, async () => true), true);
  assert.equal(ctx.STATE.invoiceLog.length, 1);
  assert.equal(ctx.STATE.invoiceLog[0].id, 'issue-ok');
});

test('角印は会社名を描画せず空の押印欄だけにする', () => {
  const ctx = {};
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(extractFunction('buildSeal') + ';globalThis.fn=buildSeal;', ctx);
  const html = ctx.fn('八龍組');
  assert.doesNotMatch(html, /八龍組/);
  assert.doesNotMatch(html, /<text\b/);
  assert.match(html, /aria-label="押印欄"/);
});

test('出面内訳と支払明細は物理A4一枚を越えない専用印刷クラスを持つ', () => {
  assert.match(source, /inv-page inv-detail-page/);
  assert.match(source, /inv-page inv-pay-slip-page/);
  assert.match(source, /#print-root \.inv-detail-page,\s*#print-root \.inv-pay-slip-page\{height:297mm;min-height:297mm;overflow:hidden;\}/);
  assert.match(source, /table class="inv-detail inv-pay-slip-detail"/);
  assert.match(source, /inv-pay-slip-detail tbody td\{font-size:7\.2pt;line-height:1\.15;padding:\.85mm 1\.5mm;\}/);
});
'''
Path('tests/invoice-output-hardening.test.js').write_text(test, encoding='utf-8')

# このスクリプトと一時workflowは適用後の正本には残さない。
for tmp in [Path('scripts/apply_invoice_hotfix.py'), Path('.github/workflows/apply-invoice-hotfix.yml')]:
    if tmp.exists():
        tmp.unlink()
