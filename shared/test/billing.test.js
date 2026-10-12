// Quotes, invoices and credit notes (D17/D18): money on a document (HST on the document, exempt lines), numbers,
// who may bill, where an invoice stands, and how invoices count in sales (money in and kept, on its day).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS as B } from '../crm.js';
import {
  taxLabel, taxLineText, roundCents, invoicedHereNote,
  documentTotals, lineAmount, formatNumber, defaultPrefix, billingAllowed, BILLING_BLOCKED, documentFingerprint, documentProblems,
  invoiceState, invoiceSalesDays, moneyText, rateText, dueDateOf, sortLines,
} from '../billing.js';

test('totals: HST 13 % on the taxable lines, rounded once on the document; exempt lines; quantities', () => {
  const lines = [
    { id: 'a', description: 'Design', quantity: 2.5, unit_cents: 12345 }, // 308.625 → 308.63
    { id: 'b', description: 'Hosting (resold)', quantity: null, unit_cents: 10000, tax_exempt: true },
    { id: 'c', description: 'Logo', quantity: 3, unit_cents: 3333 }, // 99.99
  ];
  assert.equal(lineAmount(lines[0]), 30863);
  assert.equal(lineAmount(lines[1]), 10000, 'no quantity = 1');
  const t = documentTotals(lines);
  assert.deepEqual(t, { subtotal: 50862, taxable: 40862, exempt: 10000, tax: 5312, total: 56174, rateBp: 1300 });
  // Rounded once: three lines of $0.05 at 13 % = $0.0195 → 2 ¢ (per line it would be 3 × 1 ¢).
  assert.equal(documentTotals([1, 2, 3].map((i) => ({ id: String(i), unit_cents: 5 }))).tax, 2);
  assert.equal(documentTotals(lines, 0).tax, 0, 'a 0 % document');
  assert.equal(documentTotals(lines, 500).tax, 2043, '5 %');
  assert.equal(rateText(1300), '13 %');
  assert.equal(rateText(14975), '149.75 %');
  assert.equal(moneyText(123456), '$1,234.56');
  assert.equal(moneyText(-500), '−$5.00');
  assert.deepEqual(sortLines([{ id: 'b', position: 2 }, { id: 'a', position: 2 }, { id: 'c', position: 1 }]).map((l) => l.id), ['c', 'a', 'b']);
});

test('numbers per business and kind; who may bill', () => {
  assert.equal(formatNumber('GWND', 'quote', 7), 'GWND-Q-0007');
  assert.equal(formatNumber('GWND', 'invoice', 12), 'GWND-INV-0012');
  assert.equal(formatNumber('', 'credit_note', 12345), 'CN-12345');
  assert.equal(defaultPrefix({ id: B.agency, name: 'Great White North Design' }), 'GWND');
  assert.equal(defaultPrefix({ id: B.consulting, name: 'Business consulting' }), 'BC');
  assert.equal(defaultPrefix({ id: 'x', name: 'Café du Nord' }), 'CDN');
  for (const id of [B.wholesale, B.save_point, B.personal]) {
    assert.ok(BILLING_BLOCKED[id]);
    assert.equal(billingAllowed({ id, name: 'x' }), false);
  }
  assert.equal(billingAllowed({ id: B.agency }), true);
  assert.equal(billingAllowed({ id: B.retail }), true);
  assert.equal(billingAllowed({ id: B.consulting, archived: true }), false);
  assert.equal(billingAllowed({ id: B.consulting, archived: true }, B.consulting), true, 'its own document keeps an archived business');
});

test('the fingerprint changes with anything printed, not with links or order of reading', () => {
  const doc = { business_id: B.agency, to_name: 'Alpha', title: 'Site', client_id: 'c1' };
  const lines = [{ id: '2', position: 2, description: 'B', unit_cents: 1 }, { id: '1', position: 1, description: 'A', unit_cents: 2 }];
  const f = documentFingerprint(doc, lines);
  assert.match(f, /^[0-9a-f]{8}$/);
  assert.equal(documentFingerprint({ ...doc, client_id: 'other' }, [...lines].reverse()), f);
  assert.notEqual(documentFingerprint({ ...doc, to_name: 'Alpha Inc' }, lines), f);
  assert.notEqual(documentFingerprint(doc, [{ ...lines[0], unit_cents: 3 }, lines[1]]), f);
  assert.notEqual(documentFingerprint(doc, [{ ...lines[0], tax_exempt: true }, lines[1]]), f);
  assert.notEqual(documentFingerprint(doc, lines.slice(1)), f);
});

test('a document is ready when it names who it is for and has complete lines', () => {
  assert.deepEqual(documentProblems({ to_name: 'A' }, [{ description: 'x', unit_cents: 100 }]), []);
  assert.match(documentProblems({}, [{ description: 'x', unit_cents: 100 }])[0], /who it’s for/);
  assert.match(documentProblems({ to_name: 'A' }, [])[0], /at least one line/);
  assert.match(documentProblems({ to_name: 'A' }, [{ description: ' ', unit_cents: 1 }])[0], /no description/);
  assert.match(documentProblems({ to_name: 'A' }, [{ description: 'x', quantity: 0, unit_cents: 1 }])[0], /quantity/);
  assert.match(documentProblems({ to_name: 'A' }, [{ description: 'x', unit_cents: -500 }]).join(), /below \$0/);
  assert.deepEqual(documentProblems({ to_name: 'A' }, [{ description: 'x', unit_cents: 1000 }, { description: 'Discount', unit_cents: -500 }]), [], 'a discount line is fine');
});

test('where an invoice stands: unpaid, partly paid, paid, overdue, credited, overpaid, void', () => {
  const inv = { status: 'issued', total_cents: 11300, due_date: '2026-10-31' };
  assert.equal(invoiceState({ status: 'draft' }).state, 'draft');
  assert.equal(invoiceState({ ...inv, status: 'void' }).state, 'void');
  let s = invoiceState(inv, [], [], '2026-10-15');
  assert.equal(s.state, 'unpaid');
  assert.equal(s.owing, 11300);
  assert.equal(s.overdue, false);
  s = invoiceState(inv, [{ amount_cents: 5000 }], [], '2026-11-05');
  assert.equal(s.state, 'partly_paid');
  assert.equal(s.owing, 6300);
  assert.equal(s.overdue, true);
  assert.equal(s.daysOverdue, 5);
  s = invoiceState(inv, [{ amount_cents: 5000 }, { amount_cents: 6300 }, { amount_cents: 999, deleted_at: 'x' }], [], '2026-11-05');
  assert.equal(s.state, 'paid');
  assert.equal(s.overdue, false);
  s = invoiceState(inv, [], [{ status: 'issued', total_cents: 11300 }], '2026-11-05');
  assert.equal(s.state, 'credited');
  s = invoiceState(inv, [{ amount_cents: 11300 }], [{ status: 'issued', total_cents: 2260 }, { status: 'draft', total_cents: 99 }]);
  assert.equal(s.state, 'paid');
  assert.equal(s.overpaid, 2260, 'paid in full, then credited: that much goes back');
  assert.equal(dueDateOf('2026-10-12', 30), '2026-11-11');
  assert.equal(dueDateOf('2026-10-12', 0), '2026-10-12');
});

test('invoices in sales: money in and kept, on its day; credit notes take back only what was paid; void counts nothing', () => {
  const inv = (id, business, total, sub, status = 'issued') => ({ id, business_id: business, status, subtotal_cents: sub, tax_cents: total - sub, total_cents: total });
  const invoices = [inv('i1', B.agency, 113000, 100000), inv('i2', B.agency, 56500, 50000), inv('i3', B.consulting, 22600, 20000), inv('i4', B.agency, 1000, 1000, 'void')];
  const payments = [
    { invoice_id: 'i1', amount_cents: 50000, paid_on: '2026-10-05' },
    { invoice_id: 'i1', amount_cents: 63000, paid_on: '2026-10-09' },
    { invoice_id: 'i2', amount_cents: 45200, paid_on: '2026-10-09' },
    { invoice_id: 'i3', amount_cents: 22600, paid_on: '2026-10-02' },
    { invoice_id: 'i3', amount_cents: 1, paid_on: '2026-10-02', deleted_at: 'gone' },
  ];
  const creditNotes = [
    // i1 paid in full on the 9th, then $226 credited on the 12th: money given back.
    { invoice_id: 'i1', status: 'issued', issue_date: '2026-10-12', total_cents: 22600 },
    // i2: $113 credited BEFORE its payment; then $452 paid = everything still owed. Nothing given back.
    { invoice_id: 'i2', status: 'issued', issue_date: '2026-10-08', total_cents: 11300 },
    { invoice_id: 'i3', status: 'draft', issue_date: null, total_cents: 22600 },
  ];
  const days = invoiceSalesDays(invoices, payments, creditNotes);
  const agency = days.get(B.agency);
  assert.deepEqual([...agency.keys()].sort(), ['2026-10-05', '2026-10-09', '2026-10-12']);
  assert.deepEqual(agency.get('2026-10-05'), { orders: 1, items: 0, gross: 44248, discounts: 0, refunds: 0, net: 44248, tax: 5752, shipping: 0, total: 50000 });
  const d9 = agency.get('2026-10-09');
  assert.equal(d9.total, 63000 + 45200);
  assert.equal(d9.orders, 1, 'i2 only: i1 counted once, on the day its first money came in (the 5th)');
  const d12 = agency.get('2026-10-12');
  assert.equal(d12.total, -22600);
  assert.equal(d12.refunds, 20000);
  assert.equal(d12.net, -20000);
  assert.equal(d12.tax, -2600);
  assert.equal(d12.orders, 0);
  const sum = [...agency.values()].reduce((a, r) => ({ net: a.net + r.net, tax: a.tax + r.tax, total: a.total + r.total }), { net: 0, tax: 0, total: 0 });
  assert.deepEqual(sum, { net: 100000 - 20000 + 40000, tax: 13000 - 2600 + 5200, total: 113000 - 22600 + 45200 }, 'the parts add up exactly');
  assert.equal(days.get(B.consulting).get('2026-10-02').total, 22600);
  assert.equal([...days.values()].flatMap((m) => [...m.values()]).filter((r) => r.total === 1000).length, 0, 'void counts nothing');
  // Overpaid: only the total counts; the extra is not a sale.
  const over = invoiceSalesDays([inv('i9', B.agency, 1000, 1000)], [{ invoice_id: 'i9', amount_cents: 1500, paid_on: '2026-10-01' }], []);
  assert.equal(over.get(B.agency).get('2026-10-01').total, 1000);
});

test('review: halves round away from zero (a discount mirrors its price); the tax’s name from its rate; the hand-entry note', () => {
  assert.equal(lineAmount({ quantity: 0.5, unit_cents: 5 }), 3);
  assert.equal(lineAmount({ quantity: 0.5, unit_cents: -5 }), -3, 'not −2');
  assert.equal(roundCents(-2.5), -3);
  assert.equal(roundCents(0), 0);
  assert.deepEqual([taxLabel(null), taxLabel(1300), taxLabel(500), taxLabel(0), taxLabel(700)], ['HST', 'HST', 'GST', 'Zero-rated', 'Tax']);
  assert.equal(taxLineText(500), 'GST 5 %');
  assert.equal(taxLineText(0), 'Zero-rated (0 %)');
  assert.equal(taxLineText(1300, { on: 250000 }), 'HST 13 % on $2,500.00');
  assert.match(invoicedHereNote(B.agency), /count in sales by themselves/);
  assert.ok(invoicedHereNote(B.consulting));
  assert.equal(invoicedHereNote(B.retail), null, 'retail has its own warning');
  assert.equal(invoicedHereNote(B.wholesale), null);
});
