// The alerts in the shell (C8): "Alerts" with a bell and the unread count in the sidebar, below the
// nav (desktop; not a tab-bar entry — the phone's seven tabs are full), and on
// phones a slim strip at the top of the page while something is unread. Both read the device's
// offline copy (alerts are synced records), so they work offline.
import { Link, NavLink, useLocation } from 'react-router-dom';
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

/** Desktop: "Alerts" in the sidebar, with the unread count. `className` as for the nav's links. */
export function AlertsBell({ className }) {
  const unread = useUnreadAlerts();
  const n = unread.length;
  return (
    <NavLink
      to="/alerts"
      className={className}
      aria-label={n ? `Alerts: ${unreadText(n)}` : 'Alerts'}
      data-testid="alerts-bell"
    >
      <Icon name="bell" />
      Alerts
      {n ? <span className="shell-nav-count" data-testid="alerts-count">{n > 99 ? '99+' : n}</span> : null}
    </NavLink>
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
