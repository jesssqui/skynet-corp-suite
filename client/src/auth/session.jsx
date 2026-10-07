import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, SESSION_CODES, SESSION_LOST_EVENT } from '../api/client.js';
import { clearLocalData, getDeviceId, setDeviceId, readSessionCache, saveSessionCache } from './device.js';

// Who is signed in on this device. The app shell renders only once this says
// 'signed-in'; until then the sign-in screen does (AuthGate below).
//   status: 'loading' | 'signed-out' | 'signed-in' | 'unreachable'
//   session: { user, device, session } from GET /api/auth/session
//   offline: true while signed in from the remembered session because the server can't be reached
//            (the app runs from its offline copy; the session is checked again once it can be)
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
  const [state, setState] = useState({ status: 'loading', session: null, offline: false, notice: null, error: null });
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
        if (s.status === 'signed-in') return { ...s, offline: true };
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
    const onOnline = () => (status.current === 'signed-in' || status.current === 'unreachable') && check();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    const timer = setInterval(recheckIfIn, RECHECK_MS);
    return () => {
      window.removeEventListener(SESSION_LOST_EVENT, onLost);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      clearInterval(timer);
    };
  }, [check, sessionLost]);

  /** After POST /login/code succeeded (the cookie is already set). */
  const signedIn = useCallback(async (result) => {
    const previous = getDeviceId();
    // A different device id means what this browser holds belongs to another (signed-out, or the
    // other person's) device: drop it before carrying on as the new one.
    if (previous && previous !== result.device.id) await clearLocalData();
    setDeviceId(result.device.id);
    const session = { user: result.user, device: result.device, session: result.session };
    saveSessionCache(session);
    setState({ status: 'signed-in', session, offline: false, notice: null, error: null });
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      /* already signed out or offline: clear here anyway */
    }
    await clearLocalData();
    setState({ status: 'signed-out', session: null, offline: false, notice: NOTICES.signed_out, error: null });
  }, []);

  const value = useMemo(() => ({ ...state, signedIn, signOut, recheck: check }), [state, signedIn, signOut, check]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
