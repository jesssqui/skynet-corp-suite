import { NavLink } from 'react-router-dom';
import { Icon } from '../ui/index.js';
import { navItems } from '../modules/index.js';
import './shell.css';

const linkClass = (base) => ({ isActive }) => `${base}${isActive ? ' active' : ''}`;

export default function AppShell({ children }) {
  return (
    <div className="shell">
      <nav className="shell-sidebar" aria-label="Main">
        <div className="shell-brand">
          <img className="shell-brand-mark" src="/icons/icon.svg" alt="" />
          Suite
        </div>
        {navItems.map((item) => (
          <NavLink key={item.id} to={item.path} end={item.path === '/'} className={linkClass('shell-nav-link')}>
            <Icon name={item.icon} />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <main className="shell-main">
        <div className="shell-content">{children}</div>
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
