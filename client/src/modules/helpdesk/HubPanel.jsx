// The "Support mailboxes" card's settings on System → Connections (D14): add a store's support mailbox with an app
// password. The server logs in with it and opens both folders before anything is saved, keeps the password only
// encrypted, and never sends it back. Each mailbox then has its own card (and switch).
import { useState } from 'react';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { Button, Notice, TextField, SelectField } from '../../ui/index.js';
import { api } from '../../api/client.js';
import { useServerData } from '../../api/useServerData.js';
import { businessChoices } from '../woocommerce/logic.js';
import { addMailboxProblem, providerHint, PRIVACY_NOTE, READ_ONLY_NOTE } from './logic.js';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const empty = { name: '', host: '', username: '', password: '', inboxFolder: 'INBOX', sentFolder: 'Sent', storeId: '', businessId: BUSINESS_IDS.retail };

export default function HelpdeskHubPanel({ offline, onChanged }) {
  const { data: biz } = useServerData('/api/crm/businesses', { everyMs: 0 });
  const { data: woo } = useServerData('/api/woocommerce/stores', { everyMs: 0 });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [folders, setFolders] = useState(null);
  const [added, setAdded] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v?.target ? v.target.value : v }));
  const typed = addMailboxProblem(form);
  const hint = providerHint(form.host || form.username);

  async function add() {
    setBusy(true);
    setProblem(null);
    setFolders(null);
    try {
      const { mailbox } = await api.post('/api/helpdesk/mailboxes', {
        name: form.name.trim() || undefined, host: form.host.trim(), username: form.username.trim(), password: form.password,
        inboxFolder: form.inboxFolder.trim(), sentFolder: form.sentFolder.trim(), storeId: form.storeId || null, businessId: form.businessId,
      });
      setAdded(mailbox.name);
      setForm(empty);
      setOpen(false);
      onChanged?.();
    } catch (err) {
      setProblem(err.status === 0 ? 'Can’t reach the suite server.' : err.message);
      if (err.body?.details?.folders) setFolders(err.body.details.folders);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)', borderTop: '1px solid var(--border)', paddingTop: 'var(--space-3)' }} data-testid="helpdesk-hub">
      {added ? <Notice tone="ok">{added} is connected: its last 14 days of email are being read into tickets (Support).</Notice> : null}
      {open ? (
        <div style={{ display: 'grid', gap: 'var(--space-3)' }} data-testid="helpdesk-add">
          <span style={muted}>
            Use an <strong>app password</strong> made for the suite (not the mailbox’s normal password): your mail provider makes one in its security
            settings, and you can revoke it there any time. The suite connects over TLS (port 993).
          </span>
          <TextField id="hd-name" label="Name" placeholder="TinsXpress support" value={form.name} onChange={set('name')} />
          <TextField id="hd-host" label="Mail server (IMAP)" placeholder="imap.gmail.com" value={form.host} onChange={set('host')} autoComplete="off" spellCheck={false} inputMode="url" />
          <TextField id="hd-user" label="Username" placeholder="support@tinsxpress.com" value={form.username} onChange={set('username')} autoComplete="off" spellCheck={false} inputMode="email" />
          <TextField id="hd-pass" label="App password" type="password" value={form.password} onChange={set('password')} autoComplete="off" spellCheck={false} />
          {hint ? <span style={muted}>{hint.note} Server {hint.host}; Sent folder “{hint.sent}”.</span> : null}
          <TextField id="hd-inbox" label="Inbox folder" value={form.inboxFolder} onChange={set('inboxFolder')} autoComplete="off" spellCheck={false} />
          <TextField id="hd-sent" label="Sent folder" value={form.sentFolder} onChange={set('sentFolder')} autoComplete="off" spellCheck={false}
            hint="Where your mail app keeps what you send: the suite sees your replies there." />
          <SelectField id="hd-store" label="Its WooCommerce store (for the order on each ticket)" value={form.storeId} onChange={set('storeId')}
            options={[{ value: '', label: 'None' }, ...(woo?.stores ?? []).map((s) => ({ value: s.id, label: s.name }))]} />
          <SelectField id="hd-business" label="Our business (its tasks)" value={form.businessId} onChange={set('businessId')} options={businessChoices(biz?.businesses, form.businessId)} />
          <span style={muted}>{READ_ONLY_NOTE} {PRIVACY_NOTE}</span>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button variant="primary" onClick={add} disabled={offline || busy || typed !== null} data-testid="helpdesk-add-submit">
              {busy ? 'Logging in…' : 'Add the mailbox'}
            </Button>
            <Button onClick={() => { setOpen(false); setProblem(null); setFolders(null); }}>Cancel</Button>
          </div>
          {typed && (form.host || form.username || form.password) ? <span style={muted}>{typed}</span> : null}
        </div>
      ) : (
        <div>
          <Button onClick={() => { setOpen(true); setAdded(null); }} disabled={offline} data-testid="helpdesk-add-open">Add a mailbox…</Button>
        </div>
      )}
      {problem ? <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>{problem}</p> : null}
      {folders ? <span style={muted} data-testid="helpdesk-folders">Its folders: {folders.join(' · ')}</span> : null}
    </div>
  );
}
