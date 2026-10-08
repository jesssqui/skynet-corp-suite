// A wholesale customer's figures (D1), from the holding area — no database here, so the rules are
// tested on their own. The Order Manager's own rules (its CLAUDE.md, A8 "Sales net of refunds and
// credit notes" and A7 "store credit made by a delete"):
//
//  • An order counts while it is active and not deleted (cancelled and binned orders drop out, with
//    whatever was given back on them). History-only (catch-up) orders count: they are real sales.
//  • sales = Σ goods of the counting orders, goods = subtotal − discounts: before tax, no shipping.
//  • given back (before tax, so tax is never taken off twice): a credit note's own subtotal; any other
//    refund with an amount (money back, or store credit put on the account) in its order's proportion
//    goods / (goods + tax). Store credit *used* later never counts (it would undo or double the
//    credit note / refund that made it).
//  • spend = sales − given back (what the plan calls "total spend").
//  • paid = live payments (removed ones don't count; a payment kept as store credit when its order was
//    deleted is removed as a payment and counted in credit instead).
//  • credit = store credit the customer holds: store-credit refunds + credit notes (with tax) +
//    payments moved to store credit by a delete (moved_to) − store credit used. A restore of the
//    order brings the payment back (live, moved_to cleared), so the credit goes away again.
//  • last order = the newest counting order's date; order count = counting orders.

/**
 * @param {Array<{ uid, status, deleted, goods_cents, tax_cents, order_date, has_snapshot }>} orders
 * @param {Array<{ kind, sub_kind, amount_cents, subtotal_cents, removed, moved_to, order_uid }>} money
 */
export function customerFigures(orders, money) {
  const counting = new Map();
  for (const o of orders) {
    if (o.has_snapshot && !o.deleted && o.status === 'active') counting.set(o.uid, o);
  }
  let sales = 0;
  let first = null;
  let last = null;
  for (const o of counting.values()) {
    sales += o.goods_cents;
    if (o.order_date) {
      if (!first || o.order_date < first) first = o.order_date;
      if (!last || o.order_date > last) last = o.order_date;
    }
  }
  let givenBack = 0;
  let paid = 0;
  let credit = 0;
  for (const m of money) {
    if (m.kind === 'payment') {
      if (!m.removed) paid += m.amount_cents;
      else if (m.moved_to === 'store_credit') credit += m.amount_cents;
      continue;
    }
    if (m.removed) continue;
    if (m.kind === 'credit_note') {
      credit += m.amount_cents;
      if (counting.has(m.order_uid)) givenBack += m.subtotal_cents ?? m.amount_cents;
    } else if (m.kind === 'refund') {
      if (m.sub_kind === 'store_credit_applied') {
        credit += m.amount_cents; // negative: credit used up
        continue;
      }
      if (m.sub_kind === 'store_credit') credit += m.amount_cents;
      if (m.amount_cents > 0 && counting.has(m.order_uid)) givenBack += netOfTax(m.amount_cents, counting.get(m.order_uid));
    }
  }
  return {
    order_count: counting.size,
    first_order_date: first,
    last_order_date: last,
    sales_cents: sales,
    given_back_cents: givenBack,
    spend_cents: sales - givenBack,
    paid_cents: paid,
    credit_cents: credit,
  };
}

/** A refund's amount without its share of tax: amount × goods / (goods + tax), to the cent. */
export function netOfTax(amount, order) {
  const goods = order.goods_cents;
  const withTax = goods + order.tax_cents;
  return withTax > 0 ? Math.round((amount * goods) / withTax) : amount;
}

/** What an order's own record shows: paid on it (payments + store credit used on it) and given back (with tax). */
export function orderMoney(money) {
  let paid = 0;
  let returned = 0;
  for (const m of money) {
    if (m.removed) continue;
    if (m.kind === 'payment') paid += m.amount_cents;
    else if (m.kind === 'refund' && m.sub_kind === 'store_credit_applied') paid -= m.amount_cents; // stored negative
    else if (m.kind === 'refund' && m.amount_cents > 0) returned += m.amount_cents;
    else if (m.kind === 'credit_note') returned += m.amount_cents;
  }
  return { paid_cents: paid, returned_cents: returned };
}
