// One WooCommerce store's card settings on System → Connections (D12): its address and key (never the secret), its
// business and name, what was read, Pull now, a new key, Remove. Its switch (pause) is the card's own.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Notice, TextField, SelectField, CheckboxField } from '../../ui/index.js';
import { formatDateTime } from '../../ui/format.js';
import { api } from '../../api/client.js';
import { useServerData } from '../../api/useServerData.js';
import { backfillText } from '../sales/logic.js';
import { storeIdOf, businessChoices, READ_ONLY_NOTE } from './logic.js';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 'var(--text-sm)', overflowWrap: 'anywhere' };

export default function WooStorePanel({ connection, offline, onChanged }) {
  const id = storeIdOf(connection.id);
  const { data, replace } = useServerData(`/api/woocommerce/stores/${id}`, { everyMs: 30_000 });
  const { data: biz } = useServerData('/api/crm/businesses', { everyMs: 0 });
  const [mode, setMode] = useState(null); // 'key' | 'remove' | 'edit'
  const [keyForm, setKeyForm] = useState({ key: '', secret: '', confirmed: false });
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  const store = data?.store;
  if (!store) return null;

  async function act(what, fn, after) {
    setBusy(what);
    setProblem(null);
    try {
      const out = await fn();
      if (out?.store) replace(() => ({ store: out.store }));
      after?.();
      onChanged?.();
    } catch (err) {
      setProblem(err.status === 0 ? 'Can’t reach the suite server.' : err.message);
    } finally {
      setBusy(null);
    }
  }
  const pull = () => act('pull', () => api.post(`/api/woocommerce/stores/${id}/pull`, {}));
  const saveKey = () => act('key', () => api.put(`/api/woocommerce/stores/${id}/key`, { key: keyForm.key.trim(), secret: keyForm.secret.trim(), readOnlyConfirmed: keyForm.confirmed }),
    () => { setMode(null); setKeyForm({ key: '', secret: '', confirmed: false }); });
  const saveEdit = () => act('edit', () => api.put(`/api/woocommerce/stores/${id}`, { name: edit.name, businessId: edit.businessId }), () => setMode(null));
  const remove = () => act('remove', () => api.del(`/api/woocommerce/stores/${id}`));

  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)', borderTop: '1px solid var(--border)', paddingTop: 'var(--space-3)' }} data-testid="woo-store" data-store-id={id}>
      <div style={{ display: 'grid', gap: 4 }}>
        <span style={{ fontSize: 'var(--text-sm)' }}>
          <span style={mono}>{store.url}</span> · key <span style={mono}>…{store.keyEnd}</span> · {store.currency ?? '—'} · {store.timeZone ?? 'zone unknown'}
        </span>
        <span style={muted}>{backfillText(store)}. Read only: the suite never changes anything in the store. The secret is kept encrypted on the suite’s server and can’t be shown.</span>
        {!store.readable ? <Notice tone="warn">This server can’t read the key’s secret (its key file is missing): replace the key.</Notice> : null}
        <span style={muted}><Link to={`/costs/sales/woo/${id}`}>Sales and order lookup</Link></span>
      </div>

      {mode === 'edit' ? (
        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <TextField id={`woo-name-${id}`} label="Name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          <SelectField id={`woo-biz-${id}`} label="Our business" value={edit.businessId ?? ''} onChange={(v) => setEdit({ ...edit, businessId: v })} options={businessChoices(biz?.businesses, edit.businessId)} />
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button variant="primary" onClick={saveEdit} disabled={offline || busy !== null}>Save</Button>
            <Button onClick={() => setMode(null)}>Cancel</Button>
          </div>
        </div>
      ) : null}
      {mode === 'key' ? (
        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <TextField id={`woo-newkey-${id}`} label="New consumer key" placeholder="ck_…" value={keyForm.key} onChange={(e) => setKeyForm({ ...keyForm, key: e.target.value })} autoComplete="off" spellCheck={false} />
          <TextField id={`woo-newsecret-${id}`} label="New consumer secret" placeholder="cs_…" type="password" value={keyForm.secret} onChange={(e) => setKeyForm({ ...keyForm, secret: e.target.value })} autoComplete="off" spellCheck={false} />
          <CheckboxField id={`woo-newread-${id}`} label="This key was made with permission “Read”" checked={keyForm.confirmed} onChange={(v) => setKeyForm({ ...keyForm, confirmed: v })} hint={READ_ONLY_NOTE} />
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button variant="primary" onClick={saveKey} disabled={offline || busy !== null || !keyForm.confirmed}>{busy === 'key' ? 'Checking with the store…' : 'Use this key'}</Button>
            <Button onClick={() => setMode(null)}>Cancel</Button>
          </div>
          <span style={muted}>Then revoke the old key in WooCommerce (Settings → Advanced → REST API).</span>
        </div>
      ) : null}
      {mode === 'remove' ? (
        <Notice tone="warn">
          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            <span>Remove {store.name} here? Its totals so far stay on the Sales page. Revoke its key in WooCommerce too (Settings → Advanced → REST API).</span>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <Button variant="primary" onClick={remove} disabled={offline || busy !== null}>{busy === 'remove' ? 'Removing…' : 'Remove it'}</Button>
              <Button onClick={() => setMode(null)}>Cancel</Button>
            </div>
          </div>
        </Notice>
      ) : null}
      {mode === null ? (
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Button onClick={pull} disabled={offline || busy !== null || store.paused} data-testid="woo-pull">{busy === 'pull' ? 'Reading the store…' : 'Pull now'}</Button>
          <Button onClick={() => { setEdit({ name: store.name, businessId: store.businessId }); setMode('edit'); }} disabled={offline}>Rename or business…</Button>
          <Button onClick={() => setMode('key')} disabled={offline || store.paused}>Replace the key…</Button>
          <Button onClick={() => setMode('remove')} disabled={offline}>Remove…</Button>
        </div>
      ) : null}
      {store.changes?.[0] ? <span style={{ ...muted, fontSize: 'var(--text-xs)' }}>Last change: {store.changes[0].action.replace(/_/g, ' ')} · {formatDateTime(store.changes[0].at)}</span> : null}
      {problem ? <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>{problem}</p> : null}
    </div>
  );
}
