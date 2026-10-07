import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, SESSION_CODES, SESSION_LOST_EVENT } from '../api/client.js';
import {
  clearLocalData, getDeviceId, setDeviceId, readSessionCache, saveSessionCache, readPendingSignOut, setPendingSignOut,
} from './device.js';

// Who is signed in on this device. The app shell renders only once this says
// 'signed-in'; until then the sign-in screen does (AuthGate below).
//   status: 'loading' | 'signed-out' | 'signed-in' | 'unreachable'
//   session: { user, device, session } from GET /api/auth/session
//   offline: true while signed in from the remembered session (saved at the last good check) and
//            the server hasn't confirmed it yet: the app opens at once from its offline copy, and
//            the session is checked as soon as the server can be reached
//   notice: why we're signed out ({ tone, text }) or null
const AuthContext = createContext(null);

const RECHECK_MS = 5 * 60 * 1000;

const NOTICES = {
  session_expired: { tone: 'info', text: 'Your session ended. Sign in again to carry on.' },
  device_signed_out: {
    tone: 'warn',
    text: 'This device was signed out, so the data saved on it was cleared. Sign in again to use it.',
  },
  signed_out: { tone: 'ok', text: 'Signed out. The data saved on this device was cleared.' },
};

export function AuthProvider({ children }) {
  // Someone was signed in here before: open the app straight away from the offline copy (no
  // waiting on a slow or missing connection); the check below confirms or ends the session.
  const [state, setState] = useState(() => {
    const cached = readSessionCache();
    return cached
      ? { status: 'signed-in', session: cached, offline: true, notice: null, error: null }
      : { status: 'loading', session: null, offline: false, notice: null, error: null };
  });
  const status = useRef(state.status);
  status.current = state.status;

  /** The server says there is no usable session (any request, any page). */
  const sessionLost = useCallback(async (code) => {
    // Signed out (here or from the other person's Devices page): this device's copy must go.
    if (code === 'device_signed_out') await clearLocalData();
    setState((s) => (s.status === 'signed-out' && code === 'not_signed_in'
      ? s // already on the sign-in screen: keep its message
      : { status: 'signed-out', session: null, offline: false, notice: NOTICES[code] ?? null, error: null }));
  }, []);

  const check = useCallback(async () => {
    // A sign-out made offline goes to the server first; until it does, nobody is signed in here.
    if (readPendingSignOut()) {
      try {
        await api.post('/api/auth/logout');
      } catch (err) {
        if (err.status !== 401) {
          setState((s) => (s.status === 'signed-out' ? s : { status: 'signed-out', session: null, offline: false, notice: NOTICES.signed_out, error: null }));
          return;
        }
      }
      setPendingSignOut(null);
      setState((s) => (s.status === 'signed-out' ? s : { status: 'signed-out', session: null, offline: false, notice: NOTICES.signed_out, error: null }));
      return;
    }
    try {
      const session = await api.get('/api/auth/session');
      if (!getDeviceId()) setDeviceId(session.device.id);
      saveSessionCache(session);
      setState({ status: 'signed-in', session, offline: false, notice: null, error: null });
    } catch (err) {
      if (err.status === 401 && SESSION_CODES.includes(err.code)) return; // SESSION_LOST_EVENT handles it
      // Server unreachable or failing: carry on as the person who was signed in here last, from the
      // offline copy. Anything the server would refuse (a sign-out from the other device) is
      // found out on the next request that reaches it.
      setState((s) => {
        if (s.status === 'signed-out') return s; // the sign-in screen stays (it reports its own errors)
        if (s.status === 'signed-in') {
          // Still the device whose copy this is? (Another tab may have signed out and cleared it.)
          if (getDeviceId() === s.session.device.id) return { ...s, offline: true };
          return { status: 'signed-out', session: null, offline: false, notice: NOTICES.signed_out, error: null };
        }
        const cached = readSessionCache();
        if (cached) return { status: 'signed-in', session: cached, offline: true, notice: null, error: null };
        return { status: 'unreachable', session: null, offline: false, notice: null, error: err.message };
      });
    }
  }, []);

  useEffect(() => {
    const onLost = (e) => sessionLost(e.detail.code);
    window.addEventListener(SESSION_LOST_EVENT, onLost);
    check();
    // Notice a sign-out from the other device soon: on coming back to the foreground, and now and then.
    // (Not while signing in: the sign-in screen decides when it is done.)
    const recheckIfIn = () => status.current === 'signed-in' && check();
    const onVisible = () => document.visibilityState === 'visible' && recheckIfIn();
    // Back online: confirm the session (it may have ended, or the device been signed out, meanwhile).
    const onOnline = () => (status.current === 'signed-in' || status.current === 'unreachable' || readPendingSignOut()) && check();
    // Another tab signed out, cleared this device or signed someone else in (the device id changed).
    const onStorage = (e) => (e.key === 'suite.deviceId' || e.key === null) && check();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('storage', onStorage);
    const timer = setInterval(recheckIfIn, RECHECK_MS);
    return () => {
      window.removeEventListener(SESSION_LOST_EVENT, onLost);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('storage', onStorage);
      clearInterval(timer);
    };
  }, [check, sessionLost]);

  /** After POST /login/code succeeded (the cookie is already set). */
  const signedIn = useCallback(async (result) => {
    const previous = getDeviceId();
    // A different device id means what this browser holds belongs to another (signed-out, or the
    // other person's) device: drop it before carrying on as the new one.
    if (previous && previous !== result.device.id) await clearLocalData();
    // A sign-out made offline that never reached the server: sign that device out from here now.
    const pending = readPendingSignOut();
    if (pending) {
      if (pending !== result.device.id) api.post(`/api/auth/devices/${pending}/sign-out`).catch(() => {});
      setPendingSignOut(null);
    }
    setDeviceId(result.device.id);
    const session = { user: result.user, device: result.device, session: result.session };
    saveSessionCache(session);
    setState({ status: 'signed-in', session, offline: false, notice: null, error: null });
  }, []);

  const signOut = useCallback(async () => {
    const deviceId = getDeviceId();
    let told = false;
    try {
      await api.post('/api/auth/logout');
      told = true;
    } catch (err) {
      told = err.status === 401; // already signed out
    }
    await clearLocalData();
    // Offline: the server still has the session; send the sign-out as soon as it can be reached.
    if (!told) setPendingSignOut(deviceId);
    setState({ status: 'signed-out', session: null, offline: false, notice: NOTICES.signed_out, error: null });
  }, []);

  const value = useMemo(() => ({ ...state, signedIn, signOut, recheck: check }), [state, signedIn, signOut, check]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
