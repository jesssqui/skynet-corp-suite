// The Stockroom card's words (D16): the pasted code checked before it is sent, each read's state,
// and what Stockroom lists now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeProblem, readText, listsText } from '../src/modules/stockroom/logic.js';

const fmt = (iso) => `[${iso}]`;

test('codeProblem: nothing typed is no problem yet; store codes and cut-short codes are named', () => {
  assert.equal(codeProblem(''), '');
  assert.equal(codeProblem('  '), '');
  assert.match(codeProblem('SL1.eyJ1Ijoi'), /store’s code/);
  assert.match(codeProblem('hello'), /starts with SLR1/);
  assert.match(codeProblem('SLR1.abc'), /cut short/);
  const code = `SLR1.${Buffer.from(JSON.stringify({ u: 'https://stockroom-hub.fly.dev', k: 'suite.0123456789ab', s: 'ab'.repeat(32) })).toString('base64url')}`;
  assert.equal(codeProblem(` ${code}\n`), null);
});

test('readText: read, changed, failing (with the next try), never read', () => {
  assert.equal(readText({ fetchedAt: 'a', changedAt: 'a', failures: 0 }, fmt), 'Read [a]');
  assert.equal(readText({ fetchedAt: 'b', changedAt: 'a', failures: 0 }, fmt), 'Read [b] · last change [a]');
  assert.equal(readText({ fetchedAt: 'b', failures: 3, lastError: 'Stockroom answered 503', nextTryAt: 'c' }, fmt), 'Failing (3 in a row): Stockroom answered 503 · next try [c]');
  assert.equal(readText({ fetchedAt: null, failures: 0 }, fmt), 'Not read yet');
});

test('listsText: what Stockroom lists now; reads not done yet are left out', () => {
  assert.equal(listsText({ reorderProducts: 4, reorderSuppliers: 2, deliveries: 1, differences: 2 }), '4 products to reorder from 2 suppliers · 1 delivery expected · 2 differences open');
  assert.equal(listsText({ reorderProducts: 0, reorderSuppliers: 0, deliveries: null, differences: 0 }), 'Nothing to reorder · 0 differences open');
  assert.equal(listsText({ reorderProducts: null, deliveries: null, differences: null }), '');
});
