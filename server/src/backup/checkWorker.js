// Runs in a worker thread (D10 review): the whole snapshot — better-sqlite3's backup API from its own
// read connection, the switch to a single self-contained file (journal_mode DELETE) and PRAGMA
// integrity_check — off the server's main thread. With files in the database these take seconds
// (the backup's last step writes and syncs the whole copy at once), and the server must keep answering.
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

async function snapshot({ source, file }) {
  if (source) {
    // Its own connection to the live database: a WAL read transaction, so the copy is exactly the last
    // committed state while the server keeps writing on its own connection.
    const src = new Database(source, { fileMustExist: true });
    try {
      src.pragma('busy_timeout = 5000');
      await src.backup(file, { progress: () => 2000 });
    } finally {
      src.close();
    }
  }
  const snap = new Database(file);
  try {
    snap.pragma('journal_mode = DELETE');
    return { check: snap.pragma('integrity_check', { simple: true }) };
  } finally {
    snap.close();
  }
}

snapshot(workerData).then(
  (result) => parentPort.postMessage(result),
  (err) => parentPort.postMessage({ error: err.message }),
);
