import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanFileName, fileTypeOf, extensionOf, isInlineType, magicMatches, downloadName, cleanUrl, sizeText, fileOwner, FILE_NAME_MAX, FILE_ACCEPT,
} from '../files.js';

test('cleanFileName: only the last part of a path; no control, bidi, invisible or reserved characters; short enough', () => {
  assert.equal(cleanFileName('C:\\Users\\pat\\Desktop\\Logo.png'), 'Logo.png');
  assert.equal(cleanFileName('../../etc/passwd'), 'passwd');
  assert.equal(cleanFileName('invoice\u202Efdp.exe'), 'invoice fdp.exe', 'a right-to-left override can’t disguise the extension');
  assert.equal(cleanFileName('a\u0000b\u200Bc.txt'), 'a b c.txt');
  assert.equal(cleanFileName('  ..hidden.txt  '), 'hidden.txt');
  assert.equal(cleanFileName('what?<>:"|*.pdf'), 'what.pdf');
  assert.equal(cleanFileName('Café'.normalize('NFD') + '.pdf'), 'Café.pdf', 'NFC');
  assert.equal(cleanFileName(''), 'file');
  assert.equal(cleanFileName('...'), 'file');
  assert.equal(cleanFileName(null), 'file');
  const long = cleanFileName(`${'é'.repeat(300)}.docx`);
  assert.equal([...long].length, FILE_NAME_MAX);
  assert.ok(long.endsWith('.docx'), 'the extension is kept');
});

test('types: by extension only; inline for images and PDFs; magic bytes for those', () => {
  assert.equal(extensionOf('a.tar.GZ'), 'gz');
  assert.equal(extensionOf('noext'), '');
  assert.equal(fileTypeOf('Logo.PNG').type, 'image/png');
  assert.equal(fileTypeOf('x.html'), null);
  assert.equal(fileTypeOf('x.htm'), null);
  assert.equal(fileTypeOf('x.js'), null);
  assert.equal(fileTypeOf('x.exe'), null);
  assert.equal(fileTypeOf('x.xml'), null);
  assert.equal(fileTypeOf('logo.svg').inline, false, 'SVG can carry scripts: never shown in the app');
  assert.ok(isInlineType('application/pdf'));
  assert.ok(isInlineType('image/jpeg'));
  assert.ok(!isInlineType('image/svg+xml'));
  assert.ok(!isInlineType('text/plain'));
  assert.ok(magicMatches('a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])));
  assert.ok(!magicMatches('a.png', Buffer.from('<html>')));
  assert.ok(magicMatches('a.webp', Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1')));
  assert.ok(!magicMatches('a.webp', Buffer.from('RIFF\x10\x00\x00\x00WAVEfmt ', 'latin1')));
  assert.ok(magicMatches('a.pdf', Buffer.from('%PDF-1.7')));
  assert.ok(magicMatches('a.docx', Buffer.from('anything')), 'no check for download-only types');
  assert.ok(FILE_ACCEPT.includes('.pdf') && !FILE_ACCEPT.includes('.html'));
});

test('downloadName keeps the stored type’s extension; cleanUrl; sizeText; fileOwner', () => {
  assert.equal(downloadName('Signed contract', 'application/pdf'), 'Signed contract.pdf');
  assert.equal(downloadName('Signed.pdf', 'application/pdf'), 'Signed.pdf');
  assert.equal(downloadName('photo.jpeg', 'image/jpeg'), 'photo.jpeg');
  assert.equal(downloadName('photo.png', 'image/jpeg'), 'photo.png.jpg');
  assert.equal(cleanUrl('drive.google.com/x'), 'https://drive.google.com/x');
  assert.equal(cleanUrl(' https://Example.com '), 'https://example.com/');
  assert.equal(cleanUrl('javascript:alert(1)'), null);
  assert.equal(cleanUrl('ftp://x.ca'), null);
  assert.equal(cleanUrl('https://u:p@x.ca'), null);
  assert.equal(cleanUrl(''), null);
  assert.equal(sizeText(500), '500 bytes');
  assert.equal(sizeText(2048), '2 KB');
  assert.equal(sizeText(4.2 * 1024 * 1024), '4.2 MB');
  assert.equal(sizeText(1024 ** 3), '1.0 GB');
  assert.deepEqual(fileOwner({ client_id: 'c', account_id: null }), { field: 'client_id', id: 'c' });
  assert.equal(fileOwner({ client_id: 'c', task_id: 't' }), null);
  assert.equal(fileOwner({}), null);
});
