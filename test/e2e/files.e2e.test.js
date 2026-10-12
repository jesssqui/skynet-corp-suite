// Files (D10) in the browser, on an iPhone and on a Mac: the client page's Files card, the Files tab
// with a tab per account, uploads (picker; on the Mac a drop too) with the bytes downloaded back, an
// image shown in the app, a link added during an outage (Upload switched off and saying why), a
// password pointer on an account, a file added to a task listed on the client's tab — no sideways
// scrolling at 320 px, no CSP violations. Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { WAIT, startServer, launch, watch, signIn, barSays, iphone, until, shot, airplane } from './helpers.js';

// A real 1×1 PNG (so the viewer's <img> really decodes it).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

function seed(ctx) {
  const make = (entity, fields) => {
    const r = ctx.services.sync.applyLocal({ actor: 'owner', entity, op: 'create', fields });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    return r.recordId;
  };
  const client = make('client', { name: 'Lefty’s Lounge', status: 'active' });
  const vape = make('account', { client_id: client, name: 'Lefty’s Vape Shop' });
  const cafe = make('account', { client_id: client, name: 'Lefty’s Café' });
  const task = make('task', { title: 'Send the new menu', owner: 'owner', business_id: BUSINESS_IDS.agency, client_id: client, account_id: cafe });
  return { client, vape, cafe, task };
}

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const fileRow = (db, name) => db.prepare('SELECT * FROM files_items WHERE name = ? AND deleted_at IS NULL').get(name);

async function walkThrough(page, context, server, ids, label) {
  // The client page: the Files card, empty; each account's "Files (0)".
  await page.goto(`${server.base}/crm/clients/${ids.client}`);
  const card = page.getByTestId('client-files');
  await card.getByText(/No files yet/).waitFor(WAIT);
  await page.locator(`[data-account-id="${ids.cafe}"]`).getByTestId('account-files-link').getByText('Files (0)').waitFor(WAIT);
  await page.getByTestId('client-files-link').click();
  await page.waitForURL(/\/crm\/clients\/.+\/files$/, WAIT);
  const tab = page.getByTestId('files-tab');

  // Upload two files with the picker: listed with their size once uploaded (pulled back as records).
  await tab.getByTestId('files-input').setInputFiles([
    { name: 'Lounge logo.png', mimeType: 'image/png', buffer: PNG },
    { name: 'Contract.pdf', mimeType: 'application/pdf', buffer: PDF },
  ]);
  const logo = tab.locator('[data-kind="upload"]', { hasText: 'Lounge logo.png' });
  await logo.getByText(/PNG image · \d+ bytes/).waitFor(WAIT);
  await tab.locator('[data-kind="upload"]', { hasText: 'Contract.pdf' }).getByText(/^PDF · /).waitFor(WAIT);
  await tab.getByTestId('files-uploads').waitFor({ state: 'detached', ...WAIT });
  assert.equal(fileRow(server.db, 'Lounge logo.png').client_id, ids.client);

  // Download: the very bytes, as an attachment.
  const [download] = await Promise.all([page.waitForEvent('download', WAIT), logo.getByRole('link', { name: 'Lounge logo.png' }).click()]);
  assert.equal(download.suggestedFilename(), 'Lounge logo.png');
  assert.ok(fs.readFileSync(await download.path()).equals(PNG), 'the same bytes come back');

  // The image in the app's own viewer.
  await logo.getByRole('button', { name: 'View' }).click();
  const viewer = page.getByTestId('files-viewer');
  await viewer.waitFor(WAIT);
  await page.waitForFunction(() => document.querySelector('[data-testid="files-viewer"] img')?.naturalWidth === 1, null, WAIT);
  await viewer.getByRole('button', { name: 'Close' }).click();
  await viewer.waitFor({ state: 'detached', ...WAIT });
  if (label === 'iPhone') assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on the Files tab');
  await shot(page, `d10-files-${label.toLowerCase()}`, { fullPage: false });

  // An outage: Upload is off and says why; a link is added anyway (saved once back online).
  await airplane(context, server, true);
  await barSays(page, 'Offline');
  await tab.getByText('Uploading and opening files need a connection.', { exact: false }).waitFor(WAIT);
  assert.ok(await tab.getByTestId('files-upload').isDisabled());
  await tab.getByRole('button', { name: 'Add link' }).click();
  const newLink = tab.getByTestId('files-new-link');
  await newLink.getByLabel('Address').fill('drive.google.com/drive/folders/lounge-brand');
  await newLink.getByLabel('Name (optional)').fill('Brand folder');
  await newLink.getByRole('button', { name: 'Save' }).click();
  await tab.locator('[data-kind="link"]', { hasText: 'Brand folder' }).getByText('Waiting to sync').waitFor(WAIT);
  assert.equal(fileRow(server.db, 'Brand folder'), undefined, 'not on the server yet');
  await airplane(context, server, false);
  await barSays(page, 'All changes saved');
  const link = await until(() => fileRow(server.db, 'Brand folder'), 'the link on the server');
  assert.equal(link.url, 'https://drive.google.com/drive/folders/lounge-brand');

  // The café's tab: a password pointer there (where to find it, never the password).
  await tab.waitFor(WAIT);
  await page.getByRole('tab', { name: /Lefty’s Café/ }).click();
  await page.waitForURL(new RegExp(`tab=${ids.cafe}`), WAIT);
  await page.getByTestId('files-tab').getByRole('button', { name: 'Password pointer' }).click();
  const pointer = page.getByTestId('files-new-password');
  await pointer.getByLabel('Password manager or vault (optional)').fill('1Password · Business');
  await pointer.getByLabel('Item to look for').fill('Café — WordPress admin');
  await pointer.getByLabel('Notes (optional)').fill('password: hunter2');
  await pointer.getByText('That looks like a password.').waitFor(WAIT);
  await pointer.getByLabel('Notes (optional)').fill('Ask Pat for the 2FA phone');
  await pointer.getByRole('button', { name: 'Save' }).click();
  await page.getByTestId('files-tab').locator('[data-kind="password"]').getByText('In 1Password · Business → Café — WordPress admin').waitFor(WAIT);
  const saved = await until(() => fileRow(server.db, 'Café — WordPress admin'), 'the pointer on the server');
  assert.equal(saved.account_id, ids.cafe);

  // A file added to the café's task (in the task's sheet) is listed on the café's tab and on Everything.
  await page.goto(`${server.base}/tasks?open=${ids.task}`);
  const sheet = page.getByTestId('task-form');
  await sheet.getByTestId('task-files-panel').getByTestId('files-input').setInputFiles({ name: 'Menu draft.pdf', mimeType: 'application/pdf', buffer: PDF });
  await sheet.locator('[data-kind="upload"]', { hasText: 'Menu draft.pdf' }).waitFor(WAIT);
  assert.equal(fileRow(server.db, 'Menu draft.pdf').task_id, ids.task);
  if (label === 'iPhone') assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling in the task sheet');
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await page.goto(`${server.base}/crm/clients/${ids.client}/files?tab=${ids.cafe}`);
  const menu = page.getByTestId('files-tab').locator('[data-kind="upload"]', { hasText: 'Menu draft.pdf' });
  await menu.getByText('Task: Send the new menu').waitFor(WAIT);
  await page.goto(`${server.base}/crm/clients/${ids.client}`);
  await page.locator(`[data-account-id="${ids.cafe}"]`).getByTestId('account-files-link').getByText('Files (2)').waitFor(WAIT);
  await page.getByTestId('client-files-link').getByText('All files (5)').waitFor(WAIT);

  // Refused on the device before sending: an HTML page.
  await page.getByTestId('client-files').getByTestId('files-input').setInputFiles({ name: 'page.html', mimeType: 'text/html', buffer: Buffer.from('<html></html>') });
  await page.getByTestId('client-files').getByText(/“page\.html” can’t be added/).waitFor(WAIT);

  // Renamed, then deleted.
  await page.getByTestId('client-files-link').click();
  const contract = page.getByTestId('files-tab').locator('[data-kind="upload"]', { hasText: 'Contract.pdf' });
  await contract.getByRole('button', { name: 'Edit Contract.pdf' }).click();
  await contract.getByLabel('Name').fill('Signed contract.pdf');
  await contract.getByRole('button', { name: 'Save' }).click();
  const signed = page.getByTestId('files-tab').locator('[data-kind="upload"]', { hasText: 'Signed contract.pdf' });
  await signed.waitFor(WAIT);
  await signed.getByRole('button', { name: 'Edit Signed contract.pdf' }).click();
  await signed.getByRole('button', { name: 'Delete…' }).click();
  await signed.getByRole('button', { name: 'Delete', exact: true }).click();
  await signed.waitFor({ state: 'detached', ...WAIT });
  await until(() => server.db.prepare("SELECT deleted_at FROM files_items WHERE name = 'Signed contract.pdf'").pluck().get(), 'the delete on the server');
}

test('iPhone: Files tab, uploads and downloads, a link during an outage, a password pointer, a task’s file', async (t) => {
  const server = await startServer(t);
  const ids = seed(server.ctx);
  const browser = await launch(t);
  const phone = await browser.newContext({ ...iphone(), acceptDownloads: true });
  const errors = await watch(phone);
  const page = await phone.newPage();
  await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);
  await barSays(page, 'All changes saved');
  await walkThrough(page, phone, server, ids, 'iPhone');
  // 320 px wide (the smallest iPhone): the Files tab and its tabs wrap, nothing scrolls sideways.
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`${server.base}/crm/clients/${ids.client}/files`);
  await page.getByTestId('files-tab').waitFor(WAIT);
  assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling at 320 px');
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
});

test('Mac: the same, plus a file dropped on the Files tab', async (t) => {
  const server = await startServer(t);
  const ids = seed(server.ctx);
  const browser = await launch(t);
  const mac = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const errors = await watch(mac);
  const page = await mac.newPage();
  await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);
  await barSays(page, 'All changes saved');
  await walkThrough(page, mac, server, ids, 'Mac');

  // Drop a file on the vape shop's tab.
  await page.goto(`${server.base}/crm/clients/${ids.client}/files?tab=${ids.vape}`);
  const panel = page.getByTestId('files-tab');
  await panel.waitFor(WAIT);
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['Opening hours: 10–6'], 'Hours.txt', { type: 'text/plain' }));
    return dt;
  });
  await panel.dispatchEvent('dragover', { dataTransfer });
  await panel.dispatchEvent('drop', { dataTransfer });
  await panel.locator('[data-kind="upload"]', { hasText: 'Hours.txt' }).getByText(/^Text · /).waitFor(WAIT);
  assert.equal(fileRow(server.db, 'Hours.txt').account_id, ids.vape);
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
});
