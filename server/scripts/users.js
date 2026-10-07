#!/usr/bin/env node
// Accounts are made here, on the server, never over HTTP. Safe while the server runs.
//
//   npm run user:add -- --actor owner --username jessy --name "Jessy"
//   npm run user:list
//   npm run user:password -- jessy          (set a new password; signs that person out everywhere)
//   npm run user:reset-2fa -- jessy         (lost phone AND recovery codes: next sign-in sets up 2FA again)
//
// In Docker:  docker compose exec suite node server/scripts/users.js add --actor owner --username jessy --name "Jessy"
// The password is asked for twice, without echo. For scripts: --password-stdin reads it from stdin.
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { ACTORS } from '@suite/shared/actors';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { modules } from '../src/modules/index.js';
import { createAccounts } from '../src/modules/auth/accounts.js';
import { passwordProblem } from '../src/modules/auth/crypto.js';

const USAGE = `Usage:
  users.js add --actor ${ACTORS.join('|')} --username <name> [--name "Display name"] [--password-stdin]
  users.js list
  users.js password <username> [--password-stdin]
  users.js reset-2fa <username>`;

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Print the question, not the typed characters.
      rl._writeToOutput = (s) => { if (s.startsWith(question)) rl.output.write(question); };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.replace(/\r?\n$/, '');
}

async function newPassword(fromStdin) {
  if (fromStdin) return readStdin();
  if (!process.stdin.isTTY) throw new Error('No terminal to ask for the password: use -it with docker exec, or --password-stdin');
  for (;;) {
    const first = await ask('New password (at least 12 characters): ', { hidden: true });
    const problem = passwordProblem(first);
    if (problem) {
      console.error(problem);
      continue;
    }
    const again = await ask('Same password again: ', { hidden: true });
    if (first === again) return first;
    console.error('They don’t match. Try again.');
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      actor: { type: 'string' },
      username: { type: 'string' },
      name: { type: 'string' },
      'password-stdin': { type: 'boolean', default: false },
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
      const password = await newPassword(values['password-stdin']);
      const u = await accounts.createUser({ actor: values.actor, username: values.username, displayName: values.name, password });
      console.log(`Created ${u.username} (${u.display_name}, ${u.actor}). Sign in now to set up two-factor:`
        + ' the first sign-in shows the QR code for the authenticator app.');
    } else if (command === 'list') {
      const users = accounts.listUsers();
      if (!users.length) console.log('No accounts yet.');
      for (const u of users) {
        const totp = accounts.getTotp(u.id);
        const codes = accounts.unusedRecoveryCodes(u.id).length;
        console.log(`${u.actor.padEnd(8)} ${u.username.padEnd(20)} ${u.display_name.padEnd(20)} `
          + `2FA: ${totp ? `on since ${totp.enrolled_at.slice(0, 10)}, ${codes} recovery codes left` : 'not set up yet'}`);
      }
    } else if (command === 'password') {
      const u = find(target);
      const password = await newPassword(values['password-stdin']);
      await accounts.setPassword(u.id, password, { reason: 'reset_by_admin' });
      console.log(`New password set for ${u.username}; their devices sign in again (their data stays).`);
    } else if (command === 'reset-2fa') {
      const u = find(target);
      accounts.resetTwoFactor(u.id);
      console.log(`Two-factor removed for ${u.username}; signed out of every session. Their next sign-in sets it up again — do it now.`);
    } else {
      throw new Error(USAGE);
    }
  } finally {
    db.close();
  }
}

try {
  await main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
