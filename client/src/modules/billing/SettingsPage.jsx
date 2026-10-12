// Money → Billing → Business details (/costs/billing/settings, D17/D18): what prints at the top of each business's
// quotes, invoices and credit notes (name, address, HST number, email, phone, website), how to pay (on invoices), the
// number prefix (GWND-INV-0012), and the defaults (quotes valid for, invoices due in, usual terms). Server settings
// (not synced): needs a connection to the suite. Wholesale, Save Point Shop and Personal don't bill here.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader, Card, Button, Notice, TextField, TextAreaField } from '../../ui/index.js';
import { api } from '../../api/client.js';
import { useServerData } from '../../api/useServerData.js';
import { BusinessChip } from '../crm/parts.jsx';
import MoneyTabs from '../costs/MoneyTabs.jsx';
import './billing.css';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const row = { display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' };
const FIELDS = ['legal_name', 'address', 'hst_number', 'email', 'phone', 'website', 'payment_instructions', 'prefixSet', 'quote_valid_days', 'invoice_due_days', 'quote_terms', 'invoice_terms'];
const formOf = (b) => Object.fromEntries(FIELDS.map((k) => [k, b[k] === null || b[k] === undefined ? '' : String(b[k])]));

function BusinessForm({ business, offline, onSaved }) {
  const [v, setV] = useState(() => formOf(business));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value });
  const dirty = JSON.stringify(v) !== JSON.stringify(formOf(business));
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const { prefixSet, ...rest } = v;
      const out = await api.put(`/api/billing/settings/${business.businessId}`, { ...rest, prefix: prefixSet });
      setV(formOf(out.business));
      setMsg(out.business.warning ? { tone: 'warn', text: `Saved. ${out.business.warning}.` } : { tone: 'ok', text: 'Saved.' });
      onSaved?.();
    } catch (err) {
      setMsg({ tone: 'danger', text: err.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <form onSubmit={(e) => { e.preventDefault(); save(); }} style={{ display: 'grid', gap: 'var(--space-3)' }} data-testid="billing-settings" data-business={business.businessId}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <BusinessChip business={{ id: business.businessId, name: business.name, color: business.color, archived: business.archived }} />
          <span style={muted}>Next: {business.next.quote} · {business.next.invoice} · {business.next.credit_note}</span>
        </div>
        <TextField id={`bs-name-${business.businessId}`} label="Name on documents" value={v.legal_name} onChange={set('legal_name')} placeholder={business.name} maxLength={200} />
        <TextAreaField id={`bs-address-${business.businessId}`} label="Address" value={v.address} onChange={set('address')} rows={2} maxLength={500} />
        <div style={row}>
          <TextField id={`bs-hst-${business.businessId}`} label="HST number" value={v.hst_number} onChange={set('hst_number')} placeholder="123456789 RT0001" maxLength={40} />
          <TextField id={`bs-prefix-${business.businessId}`} label="Number prefix" value={v.prefixSet} onChange={set('prefixSet')} placeholder={business.prefix} maxLength={8} hint="Like GWND: GWND-INV-0012" />
        </div>
        <div style={row}>
          <TextField id={`bs-email-${business.businessId}`} label="Email" type="email" value={v.email} onChange={set('email')} maxLength={200} />
          <TextField id={`bs-phone-${business.businessId}`} label="Phone" value={v.phone} onChange={set('phone')} maxLength={40} />
          <TextField id={`bs-web-${business.businessId}`} label="Website" value={v.website} onChange={set('website')} maxLength={200} />
        </div>
        <TextAreaField id={`bs-pay-${business.businessId}`} label="How to pay (printed on invoices)" value={v.payment_instructions} onChange={set('payment_instructions')} rows={2} maxLength={1000} placeholder="Interac e-Transfer to …" />
        <div style={row}>
          <TextField id={`bs-valid-${business.businessId}`} label="Quotes valid for (days)" inputMode="numeric" value={v.quote_valid_days} onChange={set('quote_valid_days')} />
          <TextField id={`bs-due-${business.businessId}`} label="Invoices due in (days)" inputMode="numeric" value={v.invoice_due_days} onChange={set('invoice_due_days')} hint="0 = on receipt" />
        </div>
        <TextAreaField id={`bs-qterms-${business.businessId}`} label="Usual terms on quotes" value={v.quote_terms} onChange={set('quote_terms')} rows={2} maxLength={5000} />
        <TextAreaField id={`bs-iterms-${business.businessId}`} label="Usual terms on invoices" value={v.invoice_terms} onChange={set('invoice_terms')} rows={2} maxLength={5000} />
        {msg ? <Notice tone={msg.tone === 'ok' ? 'info' : msg.tone === 'warn' ? 'warn' : 'danger'}><span data-testid="settings-message">{msg.text}</span></Notice> : null}
        <div><Button variant="primary" type="submit" disabled={busy || offline || !dirty}>Save</Button></div>
      </form>
    </Card>
  );
}

export default function SettingsPage() {
  const { data, offline, error, reload } = useServerData('/api/billing/settings', { everyMs: 0 });
  return (
    <>
      <MoneyTabs />
      <p style={{ margin: '0 0 var(--space-3)' }}><Link to="/costs/billing">← Billing</Link></p>
      <PageHeader title="Business details on documents" subtitle="What prints on each business’s quotes, invoices and credit notes. Already issued documents keep what they said." />
      {offline ? <Notice tone="warn">Needs a connection to the suite.</Notice> : null}
      {error && !offline ? <Notice tone="danger">{error.message}</Notice> : null}
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        {(data?.businesses ?? []).map((b) => <BusinessForm key={b.businessId} business={b} offline={offline} onSaved={reload} />)}
      </div>
      <p style={{ ...muted, marginTop: 'var(--space-3)' }}>Wholesale invoices stay in the Order Manager; Save Point Shop sells on eBay; Personal doesn’t bill.</p>
    </>
  );
}
