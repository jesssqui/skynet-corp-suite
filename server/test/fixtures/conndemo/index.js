// A test-only module with one connection, the way D1 (the Order Manager), C6 (Apple Calendar) and
// D16 (Stockroom) will register theirs — it proves the contract of the connections registry:
//  - jobs queue in its own outbox (written in the same step as the change that makes them);
//  - work() sends them in order to a pretend outside service (`remote`), logging a failure as an
//    error and stopping there (the rest wait, in order);
//  - while paused, work() does nothing and logs nothing — the queue keeps building;
//  - resume() catches up: everything queued goes out, in order.
import { fileURLToPath } from 'node:url';
import { nowIso } from '@suite/shared/time';

export default {
  name: 'conndemo',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService({ db, services, log }) {
    const remote = { down: false, received: [], calls: 0 };
    const state = { paused: false, lastSuccessAt: null, lastErrorAt: null, lastError: null };
    const q = {
      add: db.prepare('INSERT INTO conndemo_outbox (payload) VALUES (?)'),
      waiting: db.prepare('SELECT * FROM conndemo_outbox WHERE sent_at IS NULL ORDER BY n'),
      count: db.prepare('SELECT count(*) AS n FROM conndemo_outbox WHERE sent_at IS NULL'),
      sent: db.prepare('UPDATE conndemo_outbox SET sent_at = ? WHERE n = ?'),
    };

    function work() {
      if (state.paused) return { sent: 0, paused: true };
      let sent = 0;
      for (const job of q.waiting.all()) {
        remote.calls += 1;
        if (remote.down) {
          state.lastErrorAt = nowIso();
          state.lastError = 'The demo service did not answer';
          log.error(`conndemo: could not send job ${job.n}: ${state.lastError}`);
          return { sent, failed: true };
        }
        remote.received.push(job.payload);
        q.sent.run(nowIso(), job.n);
        state.lastSuccessAt = nowIso();
        sent += 1;
      }
      return { sent };
    }

    const handle = services.connections.register({
      id: 'conndemo',
      name: 'Demo connection',
      module: 'conndemo',
      description: 'A pretend outside service, for tests.',
      describe: () => ({
        lastSuccessAt: state.lastSuccessAt,
        lastErrorAt: state.lastErrorAt,
        lastError: state.lastError,
        queueSize: q.count.get().n,
      }),
      pause() {
        state.paused = true;
      },
      resume() {
        state.paused = false;
        work();
      },
    });

    return {
      remote,
      state,
      /** Queue a job (and try to send, as a real connection does after each change). */
      enqueue(payload) {
        q.add.run(String(payload));
        return work();
      },
      work,
      queueSize: () => q.count.get().n,
      isPaused: handle.isPaused,
    };
  },
};
