import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '../ids.js';
import { checkFieldValue, DEFAULT_TEXT_MAX } from '../fields.js';

test('checkFieldValue: the same rules on the server and on devices', () => {
  const ok = (field, value) => assert.equal(checkFieldValue({ name: 'f', ...field }, value), null, `${field.type} ${JSON.stringify(value)}`);
  const bad = (field, value) => assert.match(checkFieldValue({ name: 'f', ...field }, value) ?? 'valid', /^f/, `${field.type} ${JSON.stringify(value)}`);
  ok({ type: 'text' }, 'x'.repeat(DEFAULT_TEXT_MAX));
  bad({ type: 'text' }, 'x'.repeat(DEFAULT_TEXT_MAX + 1));
  bad({ type: 'text', max: 3 }, 'abcd');
  ok({ type: 'integer' }, 3);
  bad({ type: 'integer' }, 3.5);
  ok({ type: 'number' }, 3.5);
  bad({ type: 'number' }, Infinity);
  ok({ type: 'boolean' }, false);
  bad({ type: 'boolean' }, 0);
  ok({ type: 'date' }, '2026-02-28');
  bad({ type: 'date' }, '2026-02-30');
  ok({ type: 'datetime' }, '2026-10-06T14:03:22.120Z');
  bad({ type: 'datetime' }, '2026-10-06 14:03');
  ok({ type: 'id' }, newId());
  bad({ type: 'id' }, 'nope');
  ok({ type: 'enum', values: ['a'] }, 'a');
  bad({ type: 'enum', values: ['a'] }, 'b');
  ok({ type: 'text' }, null);
  bad({ type: 'text', required: true }, null);
  bad({ type: 'text' }, undefined);
});
