// Hybrid logical clock (HLC) stamps for offline sync (C2).
//
// Every change step carries an HLC stamp made on the device. It decides which of
// two concurrent edits of the same detail is "later" (later wins). An HLC is the
// device's wall clock, except it never goes backwards and it always moves past
// any stamp the device has seen from the server. So:
//   - a change made after seeing someone else's change always sorts after it,
//     even if this device's clock is behind;
//   - two changes nobody had seen from each other compare by wall-clock time;
//   - ties are impossible: the device id is the last part of the stamp.
// The server clamps stamps that are too far in the future (see the sync module),
// so a phone with its clock set to next year can't win every clash.
//
// Format (sorts correctly as plain text):
//   "<ms, 15 digits>-<counter, 6 digits>-<device id>"
//   "000001759760000000-000000-019a1b2c-3d4e-7f01-8a2b-3c4d5e6f7a8b"

const HLC_RE = /^(\d{15})-(\d{6})-([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const MAX_COUNTER = 999_999;

export function encodeHlc({ ms, counter, node }) {
  return `${String(ms).padStart(15, '0')}-${String(counter).padStart(6, '0')}-${node}`;
}

/** Parse a stamp into { ms, counter, node }, or null if it isn't one. */
export function parseHlc(value) {
  const m = typeof value === 'string' ? HLC_RE.exec(value) : null;
  if (!m) return null;
  return { ms: Number(m[1]), counter: Number(m[2]), node: m[3] };
}

export function isHlc(value) {
  return parseHlc(value) !== null;
}

/** -1 / 0 / 1; stamps compare as text. */
export function compareHlc(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A clock for one device (or the server).
 * @param {string} node the device id (UUIDv7) — last part of every stamp
 * @param {object} [opts]
 * @param {string|null} [opts.last] the last stamp this clock made or saw (persist it across restarts)
 * @param {() => number} [opts.wallClock] Date.now by default
 */
export function createHlc(node, { last = null, wallClock = () => Date.now() } = {}) {
  let ms = 0;
  let counter = 0;
  if (last) {
    const p = parseHlc(last);
    if (!p) throw new TypeError(`Not an HLC stamp: ${last}`);
    ms = p.ms;
    counter = p.counter;
  }

  function bump(nextMs) {
    if (nextMs > ms) {
      ms = nextMs;
      counter = 0;
    } else {
      counter += 1;
      if (counter > MAX_COUNTER) {
        ms += 1;
        counter = 0;
      }
    }
    return encodeHlc({ ms, counter, node });
  }

  return {
    /** A new stamp for a local change (strictly after everything seen so far). */
    now() {
      return bump(Math.floor(wallClock()));
    },
    /** Take in a stamp from elsewhere (pull/push responses), so later local stamps sort after it. */
    receive(remote) {
      const p = parseHlc(remote);
      if (!p) throw new TypeError(`Not an HLC stamp: ${remote}`);
      if (p.ms > ms || (p.ms === ms && p.counter > counter)) {
        ms = p.ms;
        counter = p.counter;
      }
      return encodeHlc({ ms, counter, node });
    },
    /** The latest stamp made or seen (persist this). */
    peek() {
      return encodeHlc({ ms, counter, node });
    },
  };
}
