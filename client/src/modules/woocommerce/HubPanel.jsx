// The "WooCommerce stores" card's settings on System → Connections (D12): add a store with its own read-only REST
// key. The server reads the store with it (its name, time zone, currency, one day of Analytics, one order id) before
// anything is saved, and keeps the secret only encrypted; it is never sent back. Each store then has its own card.
import { useState } from 'react';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { Button, Notice, TextField, SelectField, CheckboxField } from '../../ui/index.js';
import { api } from '../../api/client.js';
import { useServerData } from '../../api/useServerData.js';
import { addStoreProblem } from '../sales/logic.js';
import { businessChoices, KEY_STEPS, READ_ONLY_NOTE } from './logic.js';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const empty = { url: '', key: '', secret: '', businessId: BUSINESS_IDS.retail, confirmed: false };

export default function WooHubPanel({ offline, onChanged }) {
  const { data: biz } = useServerData('/api/crm/businesses', { everyMs: 0 });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [added, setAdded] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v?.target ? v.target.value : v }));
  const typed = addStoreProblem(form);

  async function add() {
    setBusy(true);
    setProblem(null);
    try {
      const { store } = await api.post('/api/woocommerce/stores', {
        url: form.url.trim(), key: form.key.trim(), secret: form.secret.trim(), businessId: form.businessId, readOnlyConfirmed: form.confirmed,
      });
      setAdded(store.name);
      setForm(empty);
      setOpen(false);
      onChanged?.();
    } catch (err) {
      setProblem(err.status === 0 ? 'Can’t reach the suite server.' : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)', borderTop: '1px solid var(--border)', paddingTop: 'var(--space-3)' }} data-testid="woo-hub">
      {added ? <Notice tone="ok">{added} is connected: its totals are being read (the first time reads 13 months, a minute or two).</Notice> : null}
      {open ? (
        <div style={{ display: 'grid', gap: 'var(--space-3)' }} data-testid="woo-add">
          <ol style={{ ...muted, margin: 0, paddingLeft: 'var(--space-4)', display: 'grid', gap: 4 }}>
            {KEY_STEPS.map((s) => <li key={s}>{s}</li>)}
          </ol>
          <TextField id="woo-url" label="Store address" placeholder="https://tinsxpress.com" value={form.url} onChange={set('url')} autoComplete="off" spellCheck={false} inputMode="url" />
          <TextField id="woo-key" label="Consumer key" placeholder="ck_…" value={form.key} onChange={set('key')} autoComplete="off" spellCheck={false} />
          <TextField id="woo-secret" label="Consumer secret" placeholder="cs_…" type="password" value={form.secret} onChange={set('secret')} autoComplete="off" spellCheck={false} />
          <SelectField id="woo-business" label="Our business" value={form.businessId} onChange={set('businessId')} options={businessChoices(biz?.businesses, form.businessId)} />
          <CheckboxField id="woo-read" label="This key was made with permission “Read”" checked={form.confirmed} onChange={set('confirmed')} hint={READ_ONLY_NOTE} />
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button variant="primary" onClick={add} disabled={offline || busy || typed !== null} data-testid="woo-add-submit">
              {busy ? 'Checking with the store…' : 'Add the store'}
            </Button>
            <Button onClick={() => { setOpen(false); setProblem(null); }}>Cancel</Button>
          </div>
          {typed && (form.url || form.key || form.secret) ? <span style={muted}>{typed}</span> : null}
        </div>
      ) : (
        <div>
          <Button onClick={() => { setOpen(true); setAdded(null); }} disabled={offline} data-testid="woo-add-open">Add a store…</Button>
        </div>
      )}
      {problem ? <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>{problem}</p> : null}
    </div>
  );
}
