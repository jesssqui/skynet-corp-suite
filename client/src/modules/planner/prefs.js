// Per-device conveniences for the planner, in localStorage (never synced, never relied on): the
// business this person last filed a task under on this device (a new task's default when nothing
// in context says otherwise), and tasks ticked off this session (shown in place, so a tick can be
// undone). Every access is wrapped: storage may be missing or throw (private mode).
import { useEffect, useState } from 'react';

const LAST_BUSINESS_KEY = 'suite.planner.lastBusiness';

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The business this person last used for a task on this device (or null). */
export function getLastBusiness(actor) {
  try {
    return JSON.parse(storage()?.getItem(LAST_BUSINESS_KEY) ?? '{}')?.[actor] ?? null;
  } catch {
    return null;
  }
}

export function setLastBusiness(actor, businessId) {
  if (!actor || !businessId) return;
  try {
    const all = JSON.parse(storage()?.getItem(LAST_BUSINESS_KEY) ?? '{}') ?? {};
    all[actor] = businessId;
    storage()?.setItem(LAST_BUSINESS_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: the default falls back to Personal */
  }
}

/** Is this a phone (where captures are recorded as source 'phone')? */
export function isPhone() {
  try {
    return /iPhone|iPod|Android.+Mobile/.test(navigator.userAgent) || window.matchMedia('(max-width: 767px)').matches;
  } catch {
    return false;
  }
}

// Ticked off this session: kept in memory (not storage) while the app is open, shared by every page.
const finished = new Set();
const listeners = new Set();

/** Remember that a task was finished here (it stays visible, ticked, until the app is reloaded). */
export function keepFinished(id) {
  finished.add(id);
  for (const fn of [...listeners]) fn();
}

/** The ids finished this session, live: { keep, version } (version changes when one is added, for useMemo). */
export function useFinishedThisSession() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const fn = () => setN((n) => n + 1);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  return { keep: finished, version: n };
}

// The Friday review's checklist ticks, per week, on this device (a convenience: the review is done
// together at one screen; nothing depends on it).
const REVIEW_KEY = 'suite.planner.review';

/** The review steps ticked for the week starting `monday` (a Set of step ids). */
export function getReviewChecks(monday) {
  try {
    const all = JSON.parse(storage()?.getItem(REVIEW_KEY) ?? '{}') ?? {};
    return new Set(Array.isArray(all[monday]) ? all[monday] : []);
  } catch {
    return new Set();
  }
}

/** Tick or untick a review step for that week (older weeks are dropped: the last 8 are kept). */
export function setReviewCheck(monday, step, on) {
  try {
    const all = JSON.parse(storage()?.getItem(REVIEW_KEY) ?? '{}') ?? {};
    const set = new Set(Array.isArray(all[monday]) ? all[monday] : []);
    if (on) set.add(step);
    else set.delete(step);
    all[monday] = [...set];
    const keep = Object.keys(all).sort().slice(-8);
    storage()?.setItem(REVIEW_KEY, JSON.stringify(Object.fromEntries(keep.map((k) => [k, all[k]]))));
  } catch {
    /* storage unavailable: the ticks last until the page closes */
  }
}
