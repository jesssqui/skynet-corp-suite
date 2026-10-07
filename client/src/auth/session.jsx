import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, SESSION_CODES, SESSION_LOST_EVENT } from '../api/client.js';
import { clearLocalData, getDeviceId, setDeviceId } from './device.js';

// Who is signed in on this device. The app shell renders only once this says
// 'signed-in'; until then the sign-in screen does (AuthGate below).
//   status: 'loading' | 'signed-out' | 'signed-in' | 'unreachable'
//   session: { user, device, session } from GET /api/auth/session
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
  const [state, setState] = useState({ status: 'loading', session: null, notice: null, error: null });
  const status = useRef(state.status);
  status.current = state.status;

  /** The server says there is no usable session (any request, any page). */
  const sessionLost = useCallback(async (code) => {
    // Signed out (here or from the other person's Devices page): this device's copy must go.
    if (code === 'device_signed_out') await clearLocalData();
    setState((s) => (s.status === 'signed-out' && code === 'not_signed_in'
      ? s // already on the sign-in screen: keep its message
      : { status: 'signed-out', session: null, notice: NOTICES[code] ?? null, error: null }));
  }, []);

  const check = useCallback(async () => {
    try {
      const session = await api.get('/api/auth/session');
      setState({ status: 'signed-in', session, notice: null, error: null });
    } catch (err) {
      if (err.status === 401 && SESSION_CODES.includes(err.code)) return; // SESSION_LOST_EVENT handles it
      // Server unreachable or failing. (C2b: run from the offline copy instead.)
      setState((s) => (s.status === 'signed-in' ? s : { status: 'unreachable', session: null, notice: null, error: err.message }));
    }
  }, []);

  useEffect(() => {
    const onLost = (e) => sessionLost(e.detail.code);
    window.addEventListener(SESSION_LOST_EVENT, onLost);
    check();
    // Notice a sign-out from the other device soon: on coming back to the foreground, and now and then.
    // (Not while signing in: the sign-in screen decides when it is done, e.g. after showing recovery codes.)
    const recheckIfIn = () => status.current === 'signed-in' && check();
    const onVisible = () => document.visibilityState === 'visible' && recheckIfIn();
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(recheckIfIn, RECHECK_MS);
    return () => {
      window.removeEventListener(SESSION_LOST_EVENT, onLost);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, [check, sessionLost]);

  /** After POST /login/code or /login/enroll succeeded (the cookie is already set). */
  const signedIn = useCallback(async (result) => {
    const previous = getDeviceId();
    // A different device id means what this browser holds belongs to another (signed-out, or the
    // other person's) device: drop it before carrying on as the new one.
    if (previous && previous !== result.device.id) await clearLocalData();
    setDeviceId(result.device.id);
    setState({ status: 'signed-in', session: { user: result.user, device: result.device, session: result.session }, notice: null, error: null });
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      /* already signed out or offline: clear here anyway */
    }
    await clearLocalData();
    setState({ status: 'signed-out', session: null, notice: NOTICES.signed_out, error: null });
  }, []);

  const value = useMemo(() => ({ ...state, signedIn, signOut, recheck: check }), [state, signedIn, signOut, check]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
