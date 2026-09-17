"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
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

test('保存関数がfalseなら発行済みにせず印刷へ進まない構造になっている', () => {
  const start = source.indexOf("$('pv-print').addEventListener('click',async()=>{");
  const end = source.indexOf('/* A4', start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);
  const save = handler.indexOf('saved=await saveInvoiceLog();');
  const falseGuard = handler.indexOf('if(!saved)', save);
  const rollback = handler.indexOf('STATE.invoiceLog.splice(i,1);', falseGuard);
  const print = handler.indexOf('window.print();');
  assert.ok(save >= 0, 'saveInvoiceLog の戻り値を待っていない');
  assert.ok(falseGuard > save, '保存結果 false を確認していない');
  assert.ok(rollback > falseGuard, '保存失敗時の履歴巻き戻しがない');
  assert.ok(print > rollback, '保存失敗を処理する前に印刷へ進んでいる');
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
