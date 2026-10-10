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
