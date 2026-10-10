// Where eBay sends the browser after "I agree" (/ebay/accepted, D13) when the RuName's accept URL is the suite's own
// address: the code and state in the address are posted to the server (which checks the state, exchanges the code and
// keeps the sign-in encrypted), then taken out of the address. /ebay/declined (the RuName's declined URL) just says so.
// Needs a connection to the suite.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { PageHeader, Card, Notice } from '../../ui/index.js';

export default function AcceptedPage({ declined = false }) {
  const [result, setResult] = useState({ phase: 'working' });
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    window.history.replaceState(null, '', window.location.pathname); // the code leaves the address bar and history
    if (declined) {
      setResult({ phase: 'error', message: 'The sign-in wasn’t agreed to on eBay: nothing changed.' });
      return;
    }
    if (!code || !state) {
      setResult({ phase: 'error', message: params.get('isAuthSuccessful') === 'false' ? 'eBay says the sign-in wasn’t agreed to: nothing changed.' : 'This page needs the code eBay sends after “I agree”: start again with Sign in to eBay.' });
      return;
    }
    api.post('/api/ebay/sign-in/finish', { code, state })
      .then((info) => setResult({ phase: 'done', info }))
      .catch((err) => setResult({ phase: 'error', message: err.status === 0 ? 'Can’t reach the suite server: start the sign-in again once it is reachable.' : err.message }));
  }, []);
  return (
    <>
      <PageHeader title="eBay sign-in" />
      <Card>
        <div style={{ display: 'grid', gap: 'var(--space-3)' }} data-testid="ebay-accepted">
          {result.phase === 'working' ? <p style={{ margin: 0 }}>Finishing the sign-in…</p> : null}
          {result.phase === 'done' ? <Notice tone="ok">Signed in to eBay{result.info?.account ? ` as ${result.info.account}` : ''}. Save Point Shop’s sales and orders to ship are being read.</Notice> : null}
          {result.phase === 'error' ? <Notice tone="danger">{result.message}</Notice> : null}
          <Link to="/system/connections">Back to Connections</Link>
        </div>
      </Card>
    </>
  );
}
