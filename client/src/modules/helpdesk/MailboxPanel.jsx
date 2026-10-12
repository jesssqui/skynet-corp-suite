// One support mailbox's card settings on System → Connections (D14): its server, username and folders (never the
// password), its store and business, what was read, Pull now, settings, a new app password, Remove. Its switch (pause:
// no calls at all) is the card's own.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Notice, TextField, SelectField } from '../../ui/index.js';
import { formatDateTime } from '../../ui/format.js';
import { api } from '../../api/client.js';
import { useServerData } from '../../api/useServerData.js';
import { businessChoices } from '../woocommerce/logic.js';
import { mailboxIdOf, mailboxStatus } from './logic.js';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 'var(--text-sm)', overflowWrap: 'anywhere' };

export default function MailboxPanel({ connection, offline, onChanged }) {
  const id = mailboxIdOf(connection.id);
  const { data, replace } = useServerData(`/api/helpdesk/mailboxes/${id}`, { everyMs: 30_000 });
  const { data: biz } = useServerData('/api/crm/businesses', { everyMs: 0 });
  const { data: woo } = useServerData('/api/woocommerce/stores', { everyMs: 0 });
  const [mode, setMode] = useState(null); // 'edit' | 'password' | 'remove'
  const [edit, setEdit] = useState(null);
  const [pass, setPass] = useState({ username: '', password: '' });
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  const mb = data?.mailbox;
  if (!mb) return null;

  async function act(what, fn, after) {
    setBusy(what);
    setProblem(null);
    try {
      const out = await fn();
      if (out?.mailbox) replace(() => ({ mailbox: out.mailbox }));
      after?.();
      onChanged?.();
    } catch (err) {
      setProblem(err.status === 0 ? 'Can’t reach the suite server.' : `${err.message}${err.body?.details?.folders ? ` Its folders: ${err.body.details.folders.join(' · ')}` : ''}`);
    } finally {
      setBusy(null);
    }
  }
  const pull = () => act('pull', () => api.post(`/api/helpdesk/mailboxes/${id}/pull`, {}));
  const save = () => act('edit', () => api.put(`/api/helpdesk/mailboxes/${id}`, edit), () => setMode(null));
  const savePass = () => act('password', () => api.put(`/api/helpdesk/mailboxes/${id}/password`, { username: pass.username.trim() || undefined, password: pass.password }),
    () => { setMode(null); setPass({ username: '', password: '' }); });
  const remove = () => act('remove', () => api.del(`/api/helpdesk/mailboxes/${id}`));
  const storeName = mb.storeId ? (woo?.stores ?? []).find((s) => s.id === mb.storeId)?.name ?? 'a store' : null;

  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)', borderTop: '1px solid var(--border)', paddingTop: 'var(--space-3)' }} data-testid="helpdesk-mailbox" data-mailbox-id={id}>
      <div style={{ display: 'grid', gap: 4 }}>
        <span style={{ fontSize: 'var(--text-sm)' }}>
          <span style={mono}>{mb.username}</span> on <span style={mono}>{mb.host}</span> · folders “{mb.inboxFolder}” and “{mb.sentFolder}”
        </span>
        <span style={muted}>{mailboxStatus(mb)}{mb.skipped ? ` · ${mb.skipped} auto-replies, lists and ignored senders skipped` : ''}</span>
        <span style={muted}>Orders looked up in: {storeName ?? 'no store (pick one under Settings)'}. Read only; the app password is kept encrypted on the suite’s server and can’t be shown.</span>
        {!mb.readable ? <Notice tone="warn">This server can’t read the app password (its key file is missing): replace it.</Notice> : null}
        <span style={muted}><Link to={`/helpdesk?mailbox=${id}`}>Its tickets</Link></span>
      </div>

      {mode === 'edit' ? (
        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <TextField id={`hd-name-${id}`} label="Name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          <TextField id={`hd-inbox-${id}`} label="Inbox folder" value={edit.inboxFolder} onChange={(e) => setEdit({ ...edit, inboxFolder: e.target.value })} />
          <TextField id={`hd-sent-${id}`} label="Sent folder" value={edit.sentFolder} onChange={(e) => setEdit({ ...edit, sentFolder: e.target.value })} />
          <TextField id={`hd-addr-${id}`} label="The mailbox’s own address" value={edit.address ?? ''} onChange={(e) => setEdit({ ...edit, address: e.target.value })}
            hint="Its own emails are never tickets." />
          <TextField id={`hd-ignore-${id}`} label="Never a ticket from" value={edit.ignoreFrom ?? ''} onChange={(e) => setEdit({ ...edit, ignoreFrom: e.target.value })}
            hint="Addresses or @domains, comma-separated — the store’s own order notifications, say." />
          <SelectField id={`hd-store-${id}`} label="Its WooCommerce store" value={edit.storeId ?? ''} onChange={(v) => setEdit({ ...edit, storeId: v || null })}
            options={[{ value: '', label: 'None' }, ...(woo?.stores ?? []).map((s) => ({ value: s.id, label: s.name }))]} />
          <SelectField id={`hd-biz-${id}`} label="Our business (its tasks)" value={edit.businessId ?? ''} onChange={(v) => setEdit({ ...edit, businessId: v })} options={businessChoices(biz?.businesses, edit.businessId)} />
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button variant="primary" onClick={save} disabled={offline || busy !== null}>{busy === 'edit' ? 'Saving…' : 'Save'}</Button>
            <Button onClick={() => setMode(null)}>Cancel</Button>
          </div>
        </div>
      ) : null}
      {mode === 'password' ? (
        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <TextField id={`hd-user-${id}`} label="Username (leave empty to keep it)" value={pass.username} onChange={(e) => setPass({ ...pass, username: e.target.value })} autoComplete="off" />
          <TextField id={`hd-pass-${id}`} label="New app password" type="password" value={pass.password} onChange={(e) => setPass({ ...pass, password: e.target.value })} autoComplete="off" />
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button variant="primary" onClick={savePass} disabled={offline || busy !== null || !pass.password}>{busy === 'password' ? 'Logging in…' : 'Use this password'}</Button>
            <Button onClick={() => setMode(null)}>Cancel</Button>
          </div>
          <span style={muted}>Then revoke the old app password with your mail provider.</span>
        </div>
      ) : null}
      {mode === 'remove' ? (
        <Notice tone="warn">
          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            <span>Remove {mb.name} here? Its tickets and the emails kept for them are deleted from the suite (nothing changes in the mailbox). Revoke its app password with your mail provider too.</span>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <Button variant="primary" onClick={remove} disabled={offline || busy !== null}>{busy === 'remove' ? 'Removing…' : 'Remove it'}</Button>
              <Button onClick={() => setMode(null)}>Cancel</Button>
            </div>
          </div>
        </Notice>
      ) : null}
      {mode === null ? (
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Button onClick={pull} disabled={offline || busy !== null || mb.paused} data-testid="helpdesk-pull">{busy === 'pull' ? 'Reading…' : 'Pull now'}</Button>
          <Button onClick={() => { setEdit({ name: mb.name, inboxFolder: mb.inboxFolder, sentFolder: mb.sentFolder, address: mb.address, ignoreFrom: mb.ignoreFrom, storeId: mb.storeId, businessId: mb.businessId }); setMode('edit'); }} disabled={offline}>Settings…</Button>
          <Button onClick={() => setMode('password')} disabled={offline || mb.paused}>Replace the app password…</Button>
          <Button onClick={() => setMode('remove')} disabled={offline}>Remove…</Button>
        </div>
      ) : null}
      {mb.lastSuccessAt ? <span style={{ ...muted, fontSize: 'var(--text-xs)' }}>Last read {formatDateTime(mb.lastSuccessAt)}</span> : null}
      {problem ? <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>{problem}</p> : null}
    </div>
  );
}
