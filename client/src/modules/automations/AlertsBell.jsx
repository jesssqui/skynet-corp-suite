// The alerts in the shell (C8): a bell with the unread count in the sidebar (desktop), and on
// phones a slim strip at the top of the page while something is unread. Both read the device's
// offline copy (alerts are synced records), so they work offline.
import { Link, useLocation } from 'react-router-dom';
import { useRecords } from '../../sync/index.js';
import { useAuth } from '../../auth/session.jsx';
import { Icon } from '../../ui/index.js';
import { unreadAlerts, unreadText } from './alerts.js';

export function useUnreadAlerts() {
  const { session } = useAuth();
  const me = session?.user?.actor;
  const { records } = useRecords('alert', { sort: '-at' });
  return me ? unreadAlerts(records ?? [], me) : [];
}

/** Desktop: the bell beside the suite's name. */
export function AlertsBell() {
  const unread = useUnreadAlerts();
  const n = unread.length;
  return (
    <Link
      to="/alerts"
      className={`shell-bell${n ? ' has-unread' : ''}`}
      aria-label={n ? `Alerts: ${unreadText(n)}` : 'Alerts'}
      title={n ? unreadText(n) : 'Alerts'}
      data-testid="alerts-bell"
    >
      <Icon name="bell" size={20} />
      {n ? <span className="shell-nav-count shell-bell-count" data-testid="alerts-count">{n > 99 ? '99+' : n}</span> : null}
    </Link>
  );
}

/** Phones: "2 new alerts · The Friday review is ready ›" while something is unread (not on /alerts). */
export function AlertsStrip() {
  const unread = useUnreadAlerts();
  const { pathname } = useLocation();
  if (!unread.length || pathname.startsWith('/alerts')) return null;
  return (
    <Link to="/alerts" className="shell-alerts-strip" data-testid="alerts-strip">
      <Icon name="bell" size={18} />
      <span className="shell-alerts-strip-text">
        <strong>{unreadText(unread.length)}</strong>
        {' · '}
        {unread[0].title}
      </span>
      <Icon name="chevron" size={16} />
    </Link>
  );
}
