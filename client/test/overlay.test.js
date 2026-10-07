// Pure display logic: pulled records + this device's changes replayed on top.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '@suite/shared/ids';
import { changesFor, overlay, cursorSeq, toView } from '../src/sync/overlay.js';

const G = newId();
const step = (op, recordId, fields, hlc) => ({ key: newId(), entity: 'item', recordId, op, ...(fields ? { fields } : {}), hlc });
const stamp = (ms) => `${String(ms).padStart(15, '0')}-000000-${G}`;

test('cursorSeq reads only cursors of the given generation', () => {
  assert.equal(cursorSeq(`${G}.42`, G), 42);
  assert.equal(cursorSeq(`${newId()}.42`, G), 0);
  assert.equal(cursorSeq(null, G), 0);
});

test('pending steps replay in stamp order over the pulled copy', () => {
  const a = newId();
  const b = newId();
  const records = [{ id: a, fields: { title: 'A', qty: 1 }, flagged: false, clashes: [] }];
  const outbox = [
    { step: step('update', a, { qty: 3 }, stamp(3)) },
    { step: step('update', a, { qty: 2, title: 'A2' }, stamp(2)) },
    { step: step('create', b, { title: 'B' }, stamp(4)) },
    { step: step('delete', a, null, stamp(5)) },
    { step: { ...step('create', newId(), { title: 'other entity' }, stamp(1)), entity: 'note' } },
  ];
  const map = overlay(records, changesFor('item', { outbox }), ['title', 'qty']);
  assert.deepEqual([...map.keys()], [b], 'the delete (last) removed A');
  assert.deepEqual(map.get(b).fields, { title: 'B', qty: null });
  assert.equal(map.get(b).pending, true);
  const noDelete = overlay(records, changesFor('item', { outbox: outbox.slice(0, 2) }), ['title', 'qty']);
  assert.deepEqual(noDelete.get(a).fields, { title: 'A2', qty: 3 }, 'qty=3 is the later stamp');
});

test('accepted steps show only what the server applied, until a complete pull passes them', () => {
  const a = newId();
  const records = [{ id: a, fields: { title: 'old', phone: 'p0' }, flagged: false, clashes: [] }];
  const won = { step: step('update', a, { title: 'mine' }, stamp(1)), generation: G, seq: 10, status: 'applied', applied: ['title'] };
  const lost = { step: step('update', a, { phone: 'p-mine' }, stamp(2)), generation: G, seq: 11, status: 'clash', applied: [] };
  const keptDelete = { step: step('delete', a, null, stamp(3)), generation: G, seq: 12, status: 'clash', kept: true };
  const view = overlay(records, changesFor('item', { sent: [won, lost, keptDelete], generation: G, seen: `${G}.9` }), ['title', 'phone']);
  assert.deepEqual(view.get(a).fields, { title: 'mine', phone: 'p0' }, 'the lost clash and the kept delete are not shown as done');
  assert.equal(view.get(a).pending, false);
  const pulled = overlay(records, changesFor('item', { sent: [won], generation: G, seen: `${G}.10` }), ['title', 'phone']);
  assert.equal(pulled.get(a).fields.title, 'old', 'once the pull covers seq 10 the pulled copy is the truth');
  const otherGeneration = overlay(records, changesFor('item', { sent: [{ ...won, generation: newId() }], generation: G, seen: null }), ['title']);
  assert.equal(otherGeneration.get(a).fields.title, 'old');
});

test('updates to a record that is not here are skipped; views put sync state under _sync', () => {
  const ghost = newId();
  const map = overlay([], changesFor('item', { outbox: [{ step: step('update', ghost, { title: 'x' }, stamp(1)) }] }), ['title']);
  assert.equal(map.size, 0);
  const id = newId();
  const view = toView('item', { id, fields: { title: 't' }, flagged: true, clashes: [{ id: 'c' }], pending: false, local: false });
  const none = { createdBy: null, createdAt: null, updatedBy: null, updatedAt: null };
  assert.deepEqual(view, { id, title: 't', _sync: { entity: 'item', pending: false, local: false, flagged: true, clashes: [{ id: 'c' }], ...none } });
  const meta = { createdBy: 'owner', createdAt: '2026-10-07T12:00:00.000Z', updatedBy: 'partner', updatedAt: '2026-10-07T13:00:00.000Z' };
  const pulled = overlay([{ id, fields: { title: 't' }, meta }], [], ['title']).get(id);
  assert.deepEqual(toView('item', pulled)._sync, { entity: 'item', pending: false, local: false, flagged: false, clashes: [], ...meta }, 'who and when come with the pulled copy');
});
