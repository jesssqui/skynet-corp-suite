import { Routes, Route, Link } from 'react-router-dom';
import AppShell from './shell/AppShell.jsx';
import { AuthProvider } from './auth/session.jsx';
import { AuthGate } from './auth/SignInScreen.jsx';
import SyncProvider from './sync/SyncProvider.jsx';
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

// Nothing of the app (shell, nav, pages, their API calls) renders until someone is signed in
// (or was, on this device, and the server can't be reached: then it runs from the offline copy).
export default function App() {
  return (
    <AuthProvider>
      <AuthGate>
        <SyncProvider>
          <AppShell>
            <Routes>
              {routes.map((r) => (
                <Route key={r.key} path={r.path} element={r.element} />
              ))}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </AppShell>
        </SyncProvider>
      </AuthGate>
    </AuthProvider>
  );
}
