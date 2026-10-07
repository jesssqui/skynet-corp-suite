import { Routes, Route, Link } from 'react-router-dom';
import AppShell from './shell/AppShell.jsx';
import { routes } from './modules/index.js';
import { EmptyState, Card } from './ui/index.js';

function NotFound() {
  return (
    <Card>
      <EmptyState title="Page not found">
        <Link to="/">Back to Today</Link>
      </EmptyState>
    </Card>
  );
}

export default function App() {
  return (
    <AppShell>
      <Routes>
        {routes.map((r) => (
          <Route key={r.key} path={r.path} element={r.element} />
        ))}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AppShell>
  );
}
