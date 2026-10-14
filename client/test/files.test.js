// Files (D10) on devices: which files a client's and an account's tab show (task files included), the
// link / password pointer forms, upload checks and answers — and two devices: links and pointers made
// offline, an upload made on the Mac listed on the phone, edits that send only what changed, deletes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '@suite/shared/ids';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { parseUploadInfo } from '../../server/src/modules/files/service.js';
import {
  filesForClient, filesOnTab, ownerForTab, tabCounts, whereText, fileDetail, downloadHref, canShow, isImage,
  entryValues, entryFields, entryChanges, looksLikeSecret, safeName, uploadProblem, uploadInfoHeader, uploadErrorText,
} from '../src/modules/files/logic.js';
import { startServer, makeDevice, row } from './helpers.js';


test('a client’s files: its own, its accounts’, and those on tasks naming the client or an account; tabs and counts', () => {
  const accounts = [{ id: 'a1', name: 'Lefty’s Vape' }, { id: 'a2', name: 'Lefty’s Café' }];
  const tasks = [
    { id: 't1', title: 'Send the logo', client_id: 'c1', account_id: null },
    { id: 't2', title: 'Menu board', client_id: null, account_id: 'a2' },
    { id: 't3', title: 'Someone else', client_id: 'c2', account_id: null },
  ];
  const files = [
    { id: '1', kind: 'upload', name: 'contract.pdf', client_id: 'c1', created_at: '2026-10-01T00:00:00.000Z' },
    { id: '2', kind: 'link', name: 'Drive', account_id: 'a1', url: 'https://drive.google.com/x', created_at: '2026-10-02T00:00:00.000Z' },
    { id: '3', kind: 'upload', name: 'logo.png', task_id: 't1', created_at: '2026-10-03T00:00:00.000Z' },
    { id: '4', kind: 'password', name: 'WP', task_id: 't2', vault: '1Password', vault_item: 'Café WP', created_at: '2026-10-04T00:00:00.000Z' },
    { id: '5', kind: 'link', name: 'Not theirs', client_id: 'c2', url: 'https://x.ca/', created_at: '2026-10-05T00:00:00.000Z' },
    { id: '6', kind: 'link', name: 'Other task', task_id: 't3', url: 'https://x.ca/', created_at: '2026-10-06T00:00:00.000Z' },
  ];
  const items = filesForClient({ files, tasks, accounts, clientId: 'c1' });
  assert.deepEqual(items.map((i) => i.file.id), ['4', '3', '2', '1'], 'newest first; other clients’ left out');
  assert.deepEqual(items.find((i) => i.file.id === '4').where, { on: 'task', taskId: 't2', accountId: 'a2' });
  assert.deepEqual(filesOnTab(items, 'client').map((i) => i.file.id), ['1']);
  assert.deepEqual(filesOnTab(items, 'a1').map((i) => i.file.id), ['2']);
  assert.deepEqual(filesOnTab(items, 'a2').map((i) => i.file.id), ['4'], 'an account’s tab shows its tasks’ files');
  assert.deepEqual(tabCounts(items, accounts), { all: 4, client: 1, a1: 1, a2: 1 });
  assert.deepEqual(ownerForTab('all', 'c1'), { field: 'client_id', id: 'c1' });
  assert.deepEqual(ownerForTab('a2', 'c1'), { field: 'account_id', id: 'a2' });
  const ctx = { accountsById: new Map(accounts.map((a) => [a.id, a])), tasksById: new Map(tasks.map((t) => [t.id, t])) };
  assert.equal(whereText({ on: 'client' }, ctx), 'Client');
  assert.equal(whereText({ on: 'account', accountId: 'a1' }, ctx), 'Lefty’s Vape');
  assert.equal(whereText({ on: 'task', taskId: 't1' }, ctx), 'Task: Send the logo');
});

test('rows: detail line, download address, what can be shown', () => {
  assert.equal(fileDetail({ kind: 'upload', name: 'Contract.pdf', content_type: 'application/pdf', size: 2.2 * 1024 * 1024 }), 'PDF · 2.2 MB');
  assert.equal(fileDetail({ kind: 'upload', name: 'Signed', content_type: 'application/pdf', size: 900 }), 'PDF · 900 bytes', 'renamed without its extension');
  assert.equal(fileDetail({ kind: 'link', url: 'https://www.dropbox.com/s/abc' }), 'dropbox.com');
  assert.equal(fileDetail({ kind: 'password', vault: '1Password · Business', vault_item: 'Lefty’s WP' }), 'In 1Password · Business → Lefty’s WP');
  assert.equal(downloadHref('abc'), '/api/files/abc/download');
  assert.equal(downloadHref('abc', { show: true }), '/api/files/abc/download?inline=1');
  assert.ok(canShow({ kind: 'upload', content_type: 'application/pdf' }));
  assert.ok(!canShow({ kind: 'upload', content_type: 'image/svg+xml' }), 'SVG is never shown in the app');
  assert.ok(isImage({ kind: 'upload', content_type: 'image/png' }));
  assert.ok(!isImage({ kind: 'upload', content_type: 'application/pdf' }));
});

test('link and password pointer forms; edits send only what changed', () => {
  let r = entryFields({ ...entryValues('link'), url: 'drive.google.com/drive/folders/x' });
  assert.deepEqual(r.problems, {});
  assert.deepEqual(r.fields, { notes: null, url: 'https://drive.google.com/drive/folders/x', name: 'drive.google.com' }, 'the name defaults to the site');
  r = entryFields({ ...entryValues('link'), url: 'javascript:alert(1)' });
  assert.ok(r.problems.url);
  r = entryFields({ ...entryValues('link') });
  assert.ok(r.problems.url);
  r = entryFields({ ...entryValues('password'), vault: '1Password', vault_item: ' Lefty’s WP ' });
  assert.deepEqual(r.fields, { notes: null, url: null, vault: '1Password', vault_item: 'Lefty’s WP', name: 'Lefty’s WP' });
  assert.ok(entryFields({ ...entryValues('password'), vault: '1Password' }).problems.vault_item);
  assert.ok(looksLikeSecret({ vault_item: 'WP admin', notes: 'password: hunter2' }));
  assert.ok(looksLikeSecret({ vault_item: 'pw=abc123' }));
  assert.ok(!looksLikeSecret({ vault_item: 'WordPress password', notes: 'in the shared vault' }));
  const record = { id: 'x', kind: 'link', name: 'Drive', url: 'https://drive.google.com/x', notes: null };
  const start = entryValues('link', record);
  assert.deepEqual(entryChanges(record, start, { ...start, notes: 'Brand folder' }).fields, { notes: 'Brand folder' });
  assert.deepEqual(entryChanges(record, start, start).fields, {});
  const upload = { id: 'u', kind: 'upload', name: 'a.pdf', notes: null };
  const us = entryValues('upload', upload);
  assert.deepEqual(entryChanges(upload, us, { ...us, name: 'Signed.pdf', url: 'https://x.ca' }).fields, { name: 'Signed.pdf' }, 'an upload has only a name and notes');
});

test('review fixes: a renamed upload is cleaned like an upload’s name; other names lose control, bidi and invisible characters', () => {
  const upload = { id: 'u', kind: 'upload', name: 'a.pdf', notes: null };
  const us = entryValues('upload', upload);
  assert.deepEqual(entryChanges(upload, us, { ...us, name: '../x/Invoice\u202Efdp.exe .pdf' }).fields, { name: 'Invoice fdp.exe.pdf' });
  assert.equal(entryFields({ ...entryValues('link'), url: 'https://x.ca', name: 'Brand\u200B fol\u0007der' }).fields.name, 'Brand folder');
  assert.equal(safeName('  a\u202Eb  '), 'ab');
  assert.equal(safeName('\u200B'), null);
});

test('uploads: checked on the device first; the header the server reads; plain-English answers', () => {
  const usage = { usedBytes: 10, maxFileBytes: 1000, maxTotalBytes: 2000 };
  assert.equal(uploadProblem({ name: 'a.pdf', size: 100 }, usage), null);
  assert.match(uploadProblem({ name: 'page.html', size: 100 }, usage), /can’t be added/);
  assert.match(uploadProblem({ name: 'a.pdf', size: 0 }, usage), /empty/);
  assert.match(uploadProblem({ name: 'a.pdf', size: 1500 }, usage), /at most 1000 bytes/);
  assert.match(uploadProblem({ name: 'a.pdf', size: 999 }, { ...usage, usedBytes: 1500 }), /No room/);
  assert.equal(uploadProblem({ name: 'a.pdf', size: 1e9 }, null), null, 'without the limits (couldn’t read them) the server decides');
  const id = newId();
  const owner = { field: 'task_id', id: newId() };
  const parsed = parseUploadInfo(uploadInfoHeader({ id, name: 'Lefty’s logo.png', owner, notes: 'v2' }));
  assert.deepEqual(parsed, { id, name: 'Lefty’s logo.png', owner, notes: 'v2' });
  assert.match(uploadErrorText(0), /needs a connection/);
  assert.match(uploadErrorText(413, { error: 'Files can be at most 25 MB' }), /25 MB/);
  assert.match(uploadErrorText(500, { error: 'Something went wrong' }), /didn’t go through/);
});

test('two devices: a link and a password pointer made offline; an upload from the Mac listed on the phone; edits and deletes', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  const mac = await makeDevice(t, server, 'owner');
  const phone = await makeDevice(t, server, 'partner');

  const clientId = await mac.engine.create('client', { name: 'Lefty’s', status: 'active' });
  const accountId = await mac.engine.create('account', { client_id: clientId, name: 'Lefty’s Vape' });
  const taskId = await mac.engine.create('task', { title: 'Send the logo', owner: 'owner', business_id: BUSINESS_IDS.agency, client_id: clientId });
  await mac.engine.syncNow();
  await phone.engine.syncNow();

  // The phone, offline: a link on the account and a password pointer on the task.
  phone.online = false;
  const link = await phone.engine.create('file', { kind: 'link', account_id: accountId, ...entryFields({ ...entryValues('link'), url: 'drive.google.com/brand' }).fields });
  const pointer = await phone.engine.create('file', { kind: 'password', task_id: taskId, ...entryFields({ ...entryValues('password'), vault: '1Password', vault_item: 'Lefty’s WP' }).fields });
  const offlineFiles = await phone.engine.list('file');
  assert.equal(offlineFiles.length, 2, 'shown at once, offline');
  phone.online = true;
  await phone.engine.syncNow();
  assert.equal(row(server.db, 'files_items', link).url, 'https://drive.google.com/brand');
  assert.equal(row(server.db, 'files_items', pointer).created_by, 'partner');

  // The Mac uploads a file to the client (online); the phone lists all three on the client's tab.
  const upId = newId();
  const res = await fetch(`${server.base}/api/files/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', origin: server.base, cookie: mac.cookie, 'x-file-info': uploadInfoHeader({ id: upId, name: 'Contract.pdf', owner: { field: 'client_id', id: clientId } }) },
    body: Buffer.from('%PDF-1.4 a contract'),
  });
  assert.equal(res.status, 201);
  await phone.engine.syncNow();
  const [files, tasks, accounts] = await Promise.all([phone.engine.list('file'), phone.engine.list('task'), phone.engine.list('account')]);
  const items = filesForClient({ files, tasks, accounts: accounts.filter((a) => a.client_id === clientId), clientId });
  assert.deepEqual(new Set(items.map((i) => i.file.id)), new Set([link, pointer, upId]));
  assert.equal(items.find((i) => i.file.id === upId).file.size, 19);

  // The Mac renames the upload while the phone adds a note: both survive (only what changed is sent).
  await mac.engine.syncNow();
  const rec = await mac.engine.get('file', upId);
  const start = entryValues('upload', rec);
  await phone.engine.update('file', upId, entryChanges(await phone.engine.get('file', upId), entryValues('upload', await phone.engine.get('file', upId)), { ...entryValues('upload', await phone.engine.get('file', upId)), notes: 'Signed by Pat' }).fields);
  await phone.engine.syncNow();
  await mac.engine.update('file', upId, entryChanges(rec, start, { ...start, name: 'Contract (signed).pdf' }).fields);
  await mac.engine.syncNow();
  const after = row(server.db, 'files_items', upId);
  assert.deepEqual([after.name, after.notes, after.size], ['Contract (signed).pdf', 'Signed by Pat', 19]);
  assert.equal(server.db.prepare('SELECT count(*) AS n FROM sync_clashes').get().n, 0);
  // A device can't change where a file is or its bytes: refused by the server, to Needs attention.
  await mac.engine.update('file', upId, { size: 1 });
  await mac.engine.syncNow();
  assert.equal(row(server.db, 'files_items', upId).size, 19);
  assert.ok((await mac.engine.attentionList()).some((a) => a.step.recordId === upId && a.code === 'invalid_value'));

  // Deleted on the phone (offline, then synced): gone from the Mac; the task deleted hides its pointer.
  phone.online = false;
  await phone.engine.remove('file', link);
  phone.online = true;
  await phone.engine.syncNow();
  await mac.engine.syncNow();
  assert.equal(await mac.engine.get('file', link), null);
  assert.ok(row(server.db, 'files_items', link).deleted_at);
  await mac.engine.remove('task', taskId);
  await mac.engine.syncNow();
  assert.equal(await mac.engine.get('file', pointer), null, 'hidden under its deleted task');
});
