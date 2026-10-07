import { NavLink } from 'react-router-dom';
import { Icon } from '../ui/index.js';
import { navItems } from '../modules/index.js';
import { useAuth } from '../auth/session.jsx';
import BackupBanner from './BackupBanner.jsx';
import UpdateBanner from './UpdateBanner.jsx';
import { SyncBar } from '../sync/components.jsx';
import './shell.css';

const linkClass = (base) => ({ isActive }) => `${base}${isActive ? ' active' : ''}`;

export default function AppShell({ children }) {
  const { session } = useAuth();
  return (
    <div className="shell">
      <nav className="shell-sidebar" aria-label="Main">
        <div className="shell-brand">
          <img className="shell-brand-mark" src="/icons/icon.svg" alt="" />
          Skynet Corp Suite
        </div>
        {navItems.map((item) => (
          <NavLink key={item.id} to={item.path} end={item.path === '/'} className={linkClass('shell-nav-link')}>
            <Icon name={item.icon} />
            {item.label}
          </NavLink>
        ))}
        <div className="shell-signed-in">
          <span>{session.user.displayName}</span>
          <span className="shell-signed-in-device">{session.device.name}</span>
        </div>
      </nav>

      <main className="shell-main">
        <div className="shell-content">
          <SyncBar />
          <UpdateBanner />
          <BackupBanner />
          {children}
        </div>
      </main>

      <nav className="shell-tabbar" aria-label="Main">
        {navItems.map((item) => (
          <NavLink key={item.id} to={item.path} end={item.path === '/'} className={linkClass('shell-tab')}>
            <Icon name={item.icon} size={22} />
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
