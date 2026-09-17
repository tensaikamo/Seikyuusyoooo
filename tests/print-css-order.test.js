"use strict";
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
