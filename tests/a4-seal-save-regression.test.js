'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'app.js'), 'utf8');

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `end marker not found: ${endMarker}`);
  return source.slice(start, end);
}

test('monthly attendance detail is designed for one daily row and up to 31 days per A4 sheet', () => {
  const invoice = section('function buildInvoiceHTML(', '/* 注意: PRINT_CSS');
  assert.match(invoice, /const ROWS_PER_SHEET=31;/);
  assert.match(invoice, /const kind=\[hasDay\?'日勤':'',hasNight\?'夜勤':''\]/);

  const paySlip = section('function buildPaySlipHTML(', 'function makePaySlip(');
  assert.match(paySlip, /inv-page inv-pay-slip-page/);
  assert.match(paySlip, /inv-detail inv-pay-slip-detail/);

  const css = section('const PRINT_CSS=`', 'const SCREEN_CSS=`');
  assert.match(css, /#print-root \.inv-detail-page,\s*#print-root \.inv-pay-slip-page\{height:297mm;min-height:297mm;overflow:hidden;\}/);
  assert.match(css, /#print-root \.inv-detail-page table\.inv-detail tbody td\{font-size:7\.2pt;line-height:1\.15;padding:\.9mm 1\.5mm;\}/);
  assert.match(css, /#print-root \.inv-pay-slip-page table\.inv-pay-slip-detail tbody td\{font-size:7\.2pt;line-height:1\.15;padding:\.85mm 1\.5mm;\}/);
});

test('generated stamp area never renders the issuer or company name inside the seal', () => {
  const seal = section('function buildSeal(){', 'function stampSeal(){');
  assert.match(seal, /aria-label="押印欄"/);
  assert.doesNotMatch(seal, /companyName|esc\(name\)|chars|<text\b/);

  const invoice = section('function buildInvoiceHTML(', '/* 注意: PRINT_CSS');
  assert.match(invoice, /\$\{buildSeal\(\)\}/);
  assert.doesNotMatch(invoice, /buildSeal\(issuer\.companyName\)/);
});

test('printing aborts when durable invoice-log storage returns false', () => {
  const handler = section("$('pv-print').addEventListener", '/* A4請求書HTML');
  const save = handler.indexOf('saved=await saveInvoiceLog()');
  const reject = handler.indexOf('if(!saved)');
  const print = handler.indexOf('window.print()');

  assert.ok(save >= 0, 'invoice log save result is not checked');
  assert.ok(reject > save, 'false save result is not rejected');
  assert.ok(print > reject, 'print can start before failed-save handling');
  assert.match(handler, /STATE\.invoiceLog\.splice/);
  assert.match(handler, /印刷は開始していません/);
});
