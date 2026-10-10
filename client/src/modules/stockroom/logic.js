// The Stockroom card's words (D16), no React (client/test/stockroom.test.js).

/** Does this look like Stockroom's suite code? ('' = nothing typed yet.) → null or a problem in plain English. */
export function codeProblem(text) {
  const c = String(text ?? '').trim();
  if (!c) return '';
  if (c.startsWith('SL1.')) return 'That is a store’s code (SL1.…). In Stockroom use Settings → Connections → Connect the suite: its code starts with SLR1.';
  if (!c.startsWith('SLR1.')) return 'Stockroom’s suite code starts with SLR1.';
  if (!/^SLR1\.[A-Za-z0-9_-]{20,}$/.test(c)) return 'The code looks cut short or changed: copy it again from Stockroom';
  return null;
}

/** One read's state: "Read Oct 9, 2:03 p.m." / "Failing (3 in a row): …" / "Not read yet". */
export function readText(read, formatDateTime) {
  if (read.failures > 0 && read.lastError) {
    const when = read.nextTryAt ? ` · next try ${formatDateTime(read.nextTryAt)}` : '';
    return `Failing${read.failures > 1 ? ` (${read.failures} in a row)` : ''}: ${read.lastError}${when}`;
  }
  if (read.fetchedAt) {
    const readAt = formatDateTime(read.fetchedAt);
    const changed = read.changedAt ? formatDateTime(read.changedAt) : null;
    return `Read ${readAt}${changed && changed !== readAt ? ` · last change ${changed}` : ''}`;
  }
  return 'Not read yet';
}

/** What Stockroom lists now: "4 products to reorder from 2 suppliers · 1 delivery expected · 2 differences open". */
export function listsText(lists) {
  if (!lists) return '';
  const n = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const parts = [];
  if (lists.reorderProducts !== null && lists.reorderProducts !== undefined) {
    parts.push(lists.reorderProducts ? `${n(lists.reorderProducts, 'product')} to reorder from ${n(lists.reorderSuppliers, 'supplier')}` : 'nothing to reorder');
  }
  if (lists.deliveries !== null && lists.deliveries !== undefined) parts.push(`${n(lists.deliveries, 'delivery', 'deliveries')} expected`);
  if (lists.differences !== null && lists.differences !== undefined) parts.push(`${n(lists.differences, 'difference')} open`);
  return parts.join(' · ').replace(/^./, (c) => c.toUpperCase());
}
