from pathlib import Path

p=Path('tests/core-invariants.test.js')
s=p.read_text(encoding='utf-8')
old="""  snapAggregate.reports[0].rep.grandTotal = 999999;
  badAggregate.invoiceLog = [sampleIssue(snapAggregate)];
  assert.throws(() => core.validateBackupPayload(badAggregate), /集計値が勤怠明細と一致/);
"""
new="""  snapAggregate.reports[0].rep.grandTotal = 999999;
  badAggregate.invoiceLog = [sampleIssue(snapAggregate)];
  assert.throws(() => core.validateBackupPayload(badAggregate), /内訳合計と合計金額が一致/);
"""
if s.count(old)!=1:
    raise SystemExit(f'ABORT: expected legacy tamper test anchor once, found {s.count(old)}')
p.write_text(s.replace(old,new,1),encoding='utf-8')
print('legacy tamper test expectation aligned')
