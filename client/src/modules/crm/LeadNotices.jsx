// D8 review: what a lead page (and a client's Leads card) says when two devices changed the same lead at
// once — "Won twice · Remove the extra" (two wins, two clients or relationships), the stage moved on two
// devices (one choice for the whole stage set, instead of field by field), and a row that doesn't add up
// ("needs a look"). The work is in leads.js (no React); settling needs a connection, like every clash.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Notice } from '../../ui/index.js';
import { useSyncEngine, useSyncStatus } from '../../sync/hooks.js';
import { useAuth } from '../../auth/session.jsx';
import { leadNeedsLook } from '@suite/shared/leads';
import { leadWins, removeExtraWins, stageClashes, settleStageClashes, STAGE_LABELS } from './leads.js';
import { useWinFixData } from './data.js';
import { errorText } from './logic.js';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const whoText = (actor, me) => (!actor ? 'someone' : actor === me ? 'you' : actor === 'system' ? 'the suite' : 'your partner');

/** The wins of a lead still standing (for a client's Leads card: is this one won twice?). */
export function useLeadWins(lead, leadActivities, clientsById, relationshipsById) {
  return useMemo(() => leadWins(lead, leadActivities ?? [], { clientsById, relationshipsById }), [lead, leadActivities, clientsById, relationshipsById]);
}

/**
 * "Won twice": links to every client the lead was won into, and Remove the extra — it takes back what the
 * extra win made only if nothing was added to it since (else it lists what stays), then settles the lead's
 * clashes keeping the win the lead names.
 */
export function WonTwice({ lead, leadActivities, clientsById, relationshipsById, compact = false }) {
  const { wins, kept, extras } = useLeadWins(lead, leadActivities, clientsById, relationshipsById);
  const engine = useSyncEngine();
  const status = useSyncStatus();
  const offline = status?.phase === 'offline';
  const { data: fixData } = useWinFixData(extras.length > 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  if (extras.length === 0 && !done) return null;
  if (done) {
    return (
      <Notice tone="info">
        <span data-testid="won-twice-done">
          {done.removed.length ? `Took back the extra win (${done.removed.map((r) => r.name).join(', ')}).` : 'Nothing could be taken back.'}
          {done.left.length ? ` ${done.left.join(' ')}` : ''}
        </span>
      </Notice>
    );
  }
  const clientLink = (w) => {
    const c = clientsById.get(w.won_client_id);
    return <Link key={w.id} to={`/crm/clients/${w.won_client_id}`}>{c?.name ?? 'a client'}</Link>;
  };
  const fix = async () => {
    setBusy(true);
    setError(null);
    try {
      setDone(await removeExtraWins(engine, lead, extras, fixData));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Notice tone="warn">
      <div style={{ display: 'grid', gap: 'var(--space-2)' }} data-testid="won-twice">
        <strong>Won twice{compact ? `: “${lead.name}”` : ''}</strong>
        <span>
          It was won on two devices at once, so it was won into {wins.map((w, i) => <span key={w.id}>{i ? ' and ' : ''}{clientLink(w)}</span>)}.
          {kept ? <> The lead keeps {clientLink(kept)}{kept.won_relationship_id && extras.some((x) => x.won_client_id === kept.won_client_id) ? ' (one of its two relationships)' : ''}.</> : null}
        </span>
        <span style={muted}>Remove the extra takes back what the other win made — only if nothing was added to it since; anything else stays and is listed.</span>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <Button variant="primary" disabled={busy || offline || !fixData || !kept} onClick={fix}>Remove the extra</Button>
          {offline ? <span style={muted}>Needs a connection.</span> : null}
          {!kept && !offline ? <span style={muted}>Settle the lead’s stage first (which win it keeps).</span> : null}
        </div>
        {error ? <span role="alert" style={{ color: 'var(--danger)' }}>{error}</span> : null}
      </div>
    </Notice>
  );
}

/**
 * The stage moved on two devices at once: one choice for the whole set (the later move won every field
 * of it). "Keep" settles every clash keep_winner; "Use … instead" applies the other move, stage last.
 */
export function StageClash({ lead }) {
  const clashes = stageClashes(lead);
  const engine = useSyncEngine();
  const status = useSyncStatus();
  const { session } = useAuth();
  const me = session?.user?.actor ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const stage = clashes.find((c) => c.field === 'stage');
  if (!stage) return null; // other fields of the set (two lost reasons…) settle field by field
  const offline = status?.phase === 'offline';
  const other = STAGE_LABELS[stage.loser?.value] ?? stage.loser?.value;
  const settle = async (resolution) => {
    setBusy(true);
    setError(null);
    try {
      await settleStageClashes(engine, lead, resolution);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const loser = stage.loser;
  return (
    <Notice tone="warn">
      <div style={{ display: 'grid', gap: 'var(--space-2)' }} data-testid="stage-clash">
        <strong>Moved on two devices at once</strong>
        <span>
          Now {STAGE_LABELS[lead.stage] ?? lead.stage} (the later change). {whoText(loser?.actor, me).replace(/^./, (c) => c.toUpperCase())} made it {other}.
        </span>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <Button disabled={busy || offline} onClick={() => settle('keep_winner')}>Keep {STAGE_LABELS[lead.stage] ?? 'this'}</Button>
          <Button disabled={busy || offline} onClick={() => settle('keep_loser')}>Use {other} instead</Button>
          {offline ? <span style={muted}>Settling this needs a connection.</span> : null}
        </div>
        {error ? <span role="alert" style={{ color: 'var(--danger)' }}>{error}</span> : null}
      </div>
    </Notice>
  );
}

/** A lead whose row doesn't add up (leadNeedsLook): say so, never guess. */
export function NeedsLook({ lead }) {
  const why = leadNeedsLook(lead);
  if (!why.length || stageClashes(lead).some((c) => c.field === 'stage')) return null;
  return (
    <Notice tone="warn">
      <span data-testid="lead-needs-look">
        This lead needs a look: it is {STAGE_LABELS[lead.stage] ?? lead.stage}, but {why.join(' and ')} (changed on two devices at once).
        Move it to the stage it should be in, or win or lose it again.
      </span>
    </Notice>
  );
}
