#!/usr/bin/env node
// Accounts are made here, on the server, never over HTTP. Safe while the server runs.
//
//   npm run user:add -- --actor owner --username jessy --name "Jessy"
//   npm run user:list
//   npm run user:password -- jessy     new password; signs that person out everywhere, unlocks the account
//   npm run user:reset-2fa -- jessy    new authenticator + recovery codes (lost phone AND lost codes); same
//   npm run user:unlock -- jessy       clear "Too many attempts" locks on that account, and on the addresses
//                                      that failed on it (those devices are unblocked for both accounts)
//   npm run user:unlock -- --all       clear every lock (all accounts, all addresses)
//
// In Docker:  docker compose exec suite node server/scripts/users.js add --actor owner --username jessy --name "Jessy"
//
// `add` and `reset-2fa` set up two-factor right here: they show a QR code (and the key), ask for one code
// from the authenticator app to confirm it, and only then save — so an account can never sign in, or be
// claimed by someone else's authenticator, without a confirmed second factor. Then they print the 10
// recovery codes once. Input is read line by line from the terminal (typing hidden for passwords) or,
// for scripts and tests, from piped stdin (password once, then the code).
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import qrcode from 'qrcode-generator';
import { ACTORS } from '@suite/shared/actors';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { modules } from '../src/modules/index.js';
import { createAccounts } from '../src/modules/auth/accounts.js';
import { passwordProblem, newTotpSecret, otpauthUrl, matchTotp } from '../src/modules/auth/crypto.js';
import { ISSUER } from '../src/modules/auth/service.js';

const USAGE = `Usage:
  users.js add --actor ${ACTORS.join('|')} --username <name> [--name "Display name"]
  users.js list
  users.js password <username>
  users.js reset-2fa <username>
  users.js unlock <username> | --all`;

const tty = Boolean(process.stdin.isTTY);
let rl;
let lines;
let muted = false;

function input() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
    // Typed characters of a hidden answer are not echoed.
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => { if (!muted) write(s); };
    lines = rl[Symbol.asyncIterator]();
  }
  return lines;
}

async function ask(question, { hidden = false } = {}) {
  const it = input();
  process.stdout.write(question);
  muted = hidden && tty;
  const { value, done } = await it.next();
  muted = false;
  if (hidden && tty) process.stdout.write('\n');
  if (done) throw new Error('Input ended before an answer was given');
  return value;
}

async function newPassword() {
  for (;;) {
    const first = await ask('New password (at least 12 characters): ', { hidden: true });
    const problem = passwordProblem(first);
    if (problem) {
      if (!tty) throw new Error(problem);
      console.error(problem);
      continue;
    }
    if (!tty) return first;
    const again = await ask('Same password again: ', { hidden: true });
    if (first === again) return first;
    console.error('They don’t match. Try again.');
  }
}

/** QR code as half-block characters, black on white whatever the terminal's colours. */
function terminalQr(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 2;
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
  const out = [];
  for (let r = -quiet; r < n + quiet; r += 2) {
    let line = '';
    for (let c = -quiet; c < n + quiet; c++) {
      const top = dark(r, c);
      const bottom = dark(r + 1, c);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    out.push(`\x1b[30;47m${line}\x1b[0m`);
  }
  return out.join('\n');
}

/** Show a new authenticator secret and wait for one right code. Returns { secret, step }. */
async function setUpAuthenticator(account) {
  const secret = newTotpSecret();
  const url = otpauthUrl({ secret, account, issuer: ISSUER });
  console.log(`\nTwo-factor for ${account}: scan this with the authenticator app on ${account}'s phone`);
  console.log('(iPhone: point the Camera at it → Add verification code → Passwords), or type the key.\n');
  console.log(terminalQr(url));
  console.log(`\nKey:  ${secret.match(/.{1,4}/g).join(' ')}`);
  console.log(`Link: ${url}\n`);
  for (let tries = 1; ; tries++) {
    const code = (await ask('Code from the app (6 digits): ')).replace(/\s/g, '');
    const step = matchTotp(secret, code, Date.now());
    if (step !== null) return { secret, step };
    if (tries >= 5) throw new Error('No matching code. Nothing was saved; run the command again.');
    console.error('That code didn’t match. Check the phone’s clock is set automatically, and try the next code.');
  }
}

function printRecoveryCodes(codes) {
  console.log('\nRecovery codes — each signs in once instead of a code if the phone is lost.');
  console.log('Save them now (password manager or paper), away from the phone. They are not shown again.\n');
  for (const c of codes) console.log(`  ${c}`);
  console.log('');
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      actor: { type: 'string' },
      username: { type: 'string' },
      name: { type: 'string' },
      all: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, target] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }

  const config = loadConfig();
  const db = openDb(config.dbPath);
  try {
    // Creates the tables on a brand-new database; a no-op when the server has already started once.
    await runMigrations(db, modules);
    const accounts = createAccounts(db, { scryptN: config.auth.scryptN });
    const find = (username) => {
      const u = username ? accounts.getUserByUsername(username) : null;
      if (!u) throw new Error(`No account named ${username ?? '(missing)'}. \`users.js list\` shows them.`);
      return u;
    };

    if (command === 'add') {
      if (!values.actor || !values.username) throw new Error(USAGE);
      const details = accounts.checkNewUser({ actor: values.actor, username: values.username, displayName: values.name });
      const password = await newPassword();
      const totp = await setUpAuthenticator(details.username);
      const { user, recoveryCodes } = await accounts.createUserWithTwoFactor({ ...details, password }, totp);
      console.log(`\nCreated ${user.username} (${user.display_name}, ${user.actor}) with two-factor on.`);
      printRecoveryCodes(recoveryCodes);
    } else if (command === 'list') {
      const users = accounts.listUsers();
      if (!users.length) console.log('No accounts yet.');
      for (const u of users) {
        const totp = accounts.getTotp(u.id);
        const codes = accounts.unusedRecoveryCodes(u.id).length;
        console.log(`${u.actor.padEnd(8)} ${u.username.padEnd(20)} ${u.display_name.padEnd(20)} `
          + `2FA: ${totp ? `on since ${totp.enrolled_at.slice(0, 10)}, ${codes} recovery codes left` : 'NOT SET UP — cannot sign in (run reset-2fa)'}`);
      }
    } else if (command === 'password') {
      const u = find(target);
      const password = await newPassword();
      await accounts.setPassword(u.id, password, { reason: 'reset_by_admin' });
      console.log(`New password set for ${u.username}; signed out everywhere (their data stays) and unlocked.`);
    } else if (command === 'reset-2fa') {
      const u = find(target);
      const totp = await setUpAuthenticator(u.username);
      const codes = accounts.replaceTwoFactor(u.id, totp.secret, totp.step);
      console.log(`\nNew authenticator saved for ${u.username}; the old one and the old recovery codes no longer work.`);
      console.log('Signed out everywhere (their data stays) and unlocked.');
      printRecoveryCodes(codes);
    } else if (command === 'unlock') {
      const plural = (n) => `${n} lock/counter record${n === 1 ? '' : 's'} cleared`;
      if (values.all) {
        console.log(`Unlocked every account and address (${plural(accounts.unlockAll())}).`);
      } else {
        const u = find(target);
        console.log(`Unlocked ${u.username} and the addresses that failed on it (${plural(accounts.unlock(u.username))}).`);
      }
    } else {
      throw new Error(USAGE);
    }
  } finally {
    rl?.close();
    db.close();
  }
}

try {
  await main();
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
