// The eBay card's words (D13): the accept URL, whether eBay can send the browser back here, the pasted address, the
// state line and the keyset form's own checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptUrlFor, acceptProblem, pastedProblem, stateLine, keysetProblem } from '../src/modules/ebay/logic.js';

test('the accept URL and whether eBay can send the browser back to it', () => {
  assert.equal(acceptUrlFor('https://mac-mini.tail1234.ts.net/'), 'https://mac-mini.tail1234.ts.net/ebay/accepted');
  assert.equal(acceptProblem('https://mac-mini.tail1234.ts.net'), null);
  assert.match(acceptProblem('http://localhost:3100'), /paste the address/);
});

test('the pasted address: code and state needed; a declined one named', () => {
  assert.equal(pastedProblem(''), '');
  assert.equal(pastedProblem('https://x.ts.net/ebay/accepted?state=s&code=v%5E1&expires_in=299'), null);
  assert.match(pastedProblem('https://x.ts.net/ebay/accepted?isAuthSuccessful=false'), /wasn’t agreed/);
  assert.match(pastedProblem('https://x.ts.net/ebay/accepted?state=s'), /No code/);
  assert.match(pastedProblem('https://x.ts.net/ebay/accepted?code=c'), /No state/);
});

test('the state line and the keyset checks', () => {
  const fmt = (d) => `[${d}]`;
  assert.match(stateLine({ state: 'not_set_up' }, fmt), /keyset/);
  assert.match(stateLine({ state: 'signed_out', signedOutReason: 'it lapsed' }, fmt), /it lapsed/);
  assert.equal(stateLine({ state: 'on', account: 'thesavepointshop', refreshExpiresAt: '2028-04-14T04:00:00.000Z' }, fmt), 'Signed in as thesavepointshop; the sign-in is good until [2028-04-14].');
  assert.equal(keysetProblem({ appId: 'SavePoin-suite-PRD-1a2b3c4d5-6e7f8a9b', certId: 'PRD-1a2b3c4d5e6f-7a8b', ruName: 'Save_Point_Shop-SavePoin-suite-abcdefgh' }), null);
  assert.match(keysetProblem({ appId: 'SavePoin-suite-SBX-1a2b3c4d5-6e7f8a9b', certId: 'PRD-1a2b3c4d5e6f-7a8b', ruName: 'x12345' }), /Sandbox/);
  assert.match(keysetProblem({ appId: 'SavePoin-suite-PRD-1a2b', certId: '', ruName: 'x12345' }), /Cert ID/);
  assert.match(keysetProblem({ appId: 'SavePoin-suite-PRD-1a2b', certId: 'PRD-1a2b3c4d5e6f', ruName: 'https://x' }), /RuName/);
});

test('review fix: the code and state leave the address before the app renders, and are taken once', async () => {
  const { captureAcceptedParams, takeAcceptedParams } = await import('../src/modules/ebay/acceptedParams.js');
  const store = new Map();
  const storage = { setItem: (k, v) => store.set(k, v), getItem: (k) => store.get(k) ?? null, removeItem: (k) => store.delete(k) };
  const replaced = [];
  const hist = { state: { x: 1 }, replaceState: (st, _t, url) => replaced.push([st, url]) };
  captureAcceptedParams({ pathname: '/ebay/accepted', search: '?state=s1&code=v%5E1.1%23i&expires_in=299' }, hist, storage);
  assert.deepEqual(replaced, [[{ x: 1 }, '/ebay/accepted']], 'the address keeps only the path');
  assert.deepEqual(takeAcceptedParams(storage), { code: 'v^1.1#i', state: 's1', declined: false });
  assert.equal(takeAcceptedParams(storage), null, 'once');
  // Elsewhere nothing is touched.
  captureAcceptedParams({ pathname: '/crm', search: '?q=Pat' }, hist, storage);
  assert.equal(replaced.length, 1);
  // A reload before the page reads them (a sign-in first): sessionStorage still has them.
  captureAcceptedParams({ pathname: '/ebay/accepted', search: '?state=s2&code=c2' }, hist, storage);
  const again = await import(`../src/modules/ebay/acceptedParams.js?reload=${Date.now()}`);
  assert.deepEqual(again.takeAcceptedParams(storage), { code: 'c2', state: 's2', declined: false });
});
