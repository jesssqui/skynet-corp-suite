// The task calendar link's address (C6a): https only, and when a link made here can't reach the iPhone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedLinks, linkReachProblem } from '../src/modules/calendar/links.js';

test('feed link: the address + path, https only (no webcal:// — it may be fetched over http, which Serve won’t answer)', () => {
  const p = '/api/calendar/feed/abc.ics';
  assert.deepEqual(feedLinks('https://mac-mini.tail1234.ts.net:8443', p), { url: 'https://mac-mini.tail1234.ts.net:8443/api/calendar/feed/abc.ics' });
  assert.equal(feedLinks('http://localhost:3100/', p).url, 'http://localhost:3100/api/calendar/feed/abc.ics');
});

test('a link made on the Mac’s own address only works there; plain http is flagged; ts.net https is fine', () => {
  assert.equal(linkReachProblem('http://localhost:3100'), 'local');
  assert.equal(linkReachProblem('http://127.0.0.1:3100'), 'local');
  assert.equal(linkReachProblem('http://100.101.102.103:3100'), 'http');
  assert.equal(linkReachProblem('https://mac-mini.tail1234.ts.net'), null);
  assert.equal(linkReachProblem('not a url'), null);
});
