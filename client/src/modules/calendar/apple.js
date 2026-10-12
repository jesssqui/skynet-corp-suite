// Account → Calendar's Apple Calendar card (C6b), no React (client/test/calendar.test.js).

const APP_PASSWORD_RE = /^([a-z]{4})-?([a-z]{4})-?([a-z]{4})-?([a-z]{4})$/;

/** The app-specific password as typed ("ABCD EFGH IJKL MNOP") → "abcd-efgh-ijkl-mnop", or null when it isn't one. */
export function cleanAppPassword(typed) {
  const m = APP_PASSWORD_RE.exec(String(typed ?? '').replace(/\s+/g, '').toLowerCase());
  return m ? `${m[1]}-${m[2]}-${m[3]}-${m[4]}` : null;
}

/** What's wrong with the form, or null (the server checks the same and then asks iCloud). */
export function connectProblem({ appleId, password }) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(appleId ?? '').trim())) return 'Enter your Apple ID: the email you sign in to iCloud with.';
  if (!cleanAppPassword(password)) {
    return 'An app-specific password is four groups of four letters (abcd-efgh-ijkl-mnop). Make one at appleid.apple.com — never type your Apple ID’s own password here.';
  }
  return null;
}

/**
 * The state line: { tone: ok | warn | danger | neutral, text }. `info` = GET /api/calendar/apple; `fmt` formats a time.
 */
export function appleState(info, fmt = (x) => x) {
  if (!info?.connected) return { tone: 'neutral', text: 'Not connected: your meetings aren’t in the suite yet.' };
  if (info.paused) return { tone: 'warn', text: 'Switched off on System → Connections: meetings stay as last read.' };
  if (info.refusedAt) return { tone: 'danger', text: 'Apple refused the app-specific password (revoked, or the Apple ID changed): enter a new one.' };
  if (info.readable === false) return { tone: 'danger', text: 'The password can’t be read on this Mac (its key file is missing): enter it again.' };
  if (info.lastError) return { tone: 'warn', text: `Last read failed ${fmt(info.lastErrorAt)}: ${info.lastError}` };
  if (info.lastSuccessAt) {
    const n = info.meetingCount ?? 0;
    return { tone: 'ok', text: `Read ${fmt(info.lastSuccessAt)} · ${n} meeting${n === 1 ? '' : 's'} from ${info.window?.from ?? ''} to ${info.window?.to ?? ''}` };
  }
  return { tone: 'neutral', text: 'Connected: not read yet.' };
}

/** The `excluded` list after ticking or unticking one calendar. */
export function toggledExcluded(calendars, url, included) {
  const out = new Set((calendars ?? []).filter((c) => !c.included).map((c) => c.url));
  if (included) out.delete(url);
  else out.add(url);
  return [...out].sort();
}
