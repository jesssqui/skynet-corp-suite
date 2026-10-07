// Shared building blocks. Every module uses these instead of styling its own,
// so the suite looks like one app. Styles are inline and use the theme tokens
// (ui.css only for what needs media queries: the Sheet).
import { useEffect, useId, useRef } from 'react';
import { Icon } from './icons.jsx';
import './ui.css';

export function PageHeader({ title, subtitle, actions }) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: 'var(--space-3)',
        flexWrap: 'wrap',
        marginBottom: 'var(--space-5)',
      }}
    >
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650, letterSpacing: '-0.01em' }}>{title}</h1>
        {subtitle ? (
          <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>{actions}</div> : null}
    </header>
  );
}

export function Card({ title, children, style, padded = true }) {
  return (
    <section
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow)',
        padding: padded ? 'var(--space-4)' : 0,
        ...style,
      }}
    >
      {title ? (
        <h2
          style={{
            fontSize: 'var(--text-sm)',
            fontWeight: 600,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            marginBottom: 'var(--space-3)',
          }}
        >
          {title}
        </h2>
      ) : null}
      {children}
    </section>
  );
}

const buttonVariants = {
  primary: { background: 'var(--accent)', color: 'var(--on-accent)', border: '1px solid var(--accent)' },
  secondary: { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' },
  ghost: { background: 'transparent', color: 'var(--text)', border: '1px solid transparent' },
  danger: { background: 'var(--danger)', color: '#fff', border: '1px solid var(--danger)' },
};

export function Button({ variant = 'secondary', type = 'button', style, children, ...rest }) {
  return (
    <button
      type={type}
      style={{
        ...buttonVariants[variant],
        minHeight: 'var(--tap)',
        padding: '0 var(--space-4)',
        borderRadius: 'var(--radius)',
        fontWeight: 550,
        fontSize: 'var(--text-md)',
        cursor: rest.disabled ? 'default' : 'pointer',
        opacity: rest.disabled ? 0.55 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-2)',
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

const badgeTones = {
  neutral: { background: 'var(--surface-2)', color: 'var(--text-muted)' },
  ok: { background: 'var(--ok-soft)', color: 'var(--ok)' },
  warn: { background: 'var(--warn-soft)', color: 'var(--warn)' },
  danger: { background: 'var(--danger-soft)', color: 'var(--danger)' },
  accent: { background: 'var(--accent-soft)', color: 'var(--accent)' },
};

export function Badge({ tone = 'neutral', children }) {
  return (
    <span
      style={{
        ...badgeTones[tone],
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        padding: '2px var(--space-2)',
        borderRadius: '999px',
        fontSize: 'var(--text-xs)',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

/** Label/value rows, e.g. on detail and status pages. */
export function KeyValue({ rows }) {
  return (
    <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'minmax(110px, auto) 1fr', rowGap: 'var(--space-2)', columnGap: 'var(--space-4)' }}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'contents' }}>
          <dt style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>{label}</dt>
          <dd style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EmptyState({ title, children }) {
  return (
    <div style={{ textAlign: 'center', padding: 'var(--space-6) var(--space-4)', color: 'var(--text-muted)' }}>
      <p style={{ margin: 0, fontWeight: 600, color: 'var(--text)' }}>{title}</p>
      {children ? <p style={{ margin: 'var(--space-2) 0 0', fontSize: 'var(--text-sm)' }}>{children}</p> : null}
    </div>
  );
}

/** Pick one of a few options (theme switch, filters). */
export function Segmented({ value, onChange, options, label }) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      style={{ display: 'inline-flex', background: 'var(--surface-2)', borderRadius: 'var(--radius)', padding: 3, gap: 2 }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            style={{
              minHeight: 38,
              padding: '0 var(--space-3)',
              border: 0,
              borderRadius: 'calc(var(--radius) - 3px)',
              background: active ? 'var(--surface)' : 'transparent',
              boxShadow: active ? 'var(--shadow)' : 'none',
              color: active ? 'var(--text)' : 'var(--text-muted)',
              fontWeight: active ? 600 : 500,
              fontSize: 'var(--text-sm)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A labelled text input. Inputs are 16px so iPhone Safari doesn't zoom in on focus.
 * `hint` shows under the field; `error` replaces it in the danger colour.
 */
export function TextField({ label, hint, error, id, style, inputStyle, ...rest }) {
  const fieldId = id ?? `f-${label.replace(/\W+/g, '-').toLowerCase()}`;
  const note = error || hint;
  return (
    <div style={{ display: 'grid', gap: 6, ...style }}>
      <label htmlFor={fieldId} style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{label}</label>
      <input
        id={fieldId}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? `${fieldId}-note` : undefined}
        style={{
          minHeight: 'var(--tap)',
          padding: '0 var(--space-3)',
          fontSize: 16,
          background: 'var(--surface)',
          border: `1px solid ${error ? 'var(--danger)' : 'var(--border)'}`,
          borderRadius: 'var(--radius)',
          width: '100%',
          ...inputStyle,
        }}
        {...rest}
      />
      {note ? (
        <span id={`${fieldId}-note`} style={{ fontSize: 'var(--text-xs)', color: error ? 'var(--danger)' : 'var(--text-muted)' }}>
          {note}
        </span>
      ) : null}
    </div>
  );
}

const noticeTones = {
  info: { background: 'var(--accent-soft)', color: 'var(--text)', border: 'var(--accent)' },
  ok: { background: 'var(--ok-soft)', color: 'var(--text)', border: 'var(--ok)' },
  warn: { background: 'var(--warn-soft)', color: 'var(--text)', border: 'var(--warn)' },
  danger: { background: 'var(--danger-soft)', color: 'var(--danger)', border: 'var(--danger)' },
};

/** A short message in a tinted box (errors, confirmations, "this device was signed out"). */
export function Notice({ tone = 'info', children, style }) {
  const t = noticeTones[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      style={{
        background: t.background,
        color: t.color,
        borderLeft: `3px solid ${t.border}`,
        borderRadius: 'var(--radius-sm)',
        padding: 'var(--space-3) var(--space-4)',
        fontSize: 'var(--text-sm)',
        overflowWrap: 'anywhere',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

const fieldInputStyle = {
  minHeight: 'var(--tap)',
  padding: '0 var(--space-3)',
  fontSize: 16,
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  width: '100%',
  minWidth: 0,
};

function fieldIdOf(id, label) {
  return id ?? `f-${String(label).replace(/\W+/g, '-').toLowerCase()}`;
}

function FieldFrame({ id, label, hint, error, children, style }) {
  const note = error || hint;
  return (
    <div style={{ display: 'grid', gap: 6, minWidth: 0, ...style }}>
      <label htmlFor={id} style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{label}</label>
      {children}
      {note ? (
        <span id={`${id}-note`} style={{ fontSize: 'var(--text-xs)', color: error ? 'var(--danger)' : 'var(--text-muted)' }}>
          {note}
        </span>
      ) : null}
    </div>
  );
}

/** Options in runs: consecutive options with the same `group` go under one <optgroup>. */
function optionGroups(options) {
  const out = [];
  for (const o of options) {
    const last = out[out.length - 1];
    if (last && last.group === (o.group ?? null)) last.options.push(o);
    else out.push({ group: o.group ?? null, options: [o] });
  }
  return out;
}

/**
 * A labelled <select>. options: [{ value, label, group? }] (value '' = nothing chosen; consecutive
 * options with the same `group` are shown under an <optgroup>). onChange gets the value string.
 */
export function SelectField({ label, hint, error, id, value, onChange, options, style, selectStyle, ...rest }) {
  const fieldId = fieldIdOf(id, label);
  return (
    <FieldFrame id={fieldId} label={label} hint={hint} error={error} style={style}>
      <select
        id={fieldId}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${fieldId}-note` : undefined}
        style={{ ...fieldInputStyle, ...(error ? { borderColor: 'var(--danger)' } : {}), ...selectStyle }}
        {...rest}
      >
        {optionGroups(options).map((g) => (g.group
          ? <optgroup key={`g:${g.group}`} label={g.group}>{g.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</optgroup>
          : g.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)))}
      </select>
    </FieldFrame>
  );
}

/** A labelled multi-line text input (16px, so iPhone Safari doesn't zoom). */
export function TextAreaField({ label, hint, error, id, rows = 3, style, inputStyle, ...rest }) {
  const fieldId = fieldIdOf(id, label);
  return (
    <FieldFrame id={fieldId} label={label} hint={hint} error={error} style={style}>
      <textarea
        id={fieldId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${fieldId}-note` : undefined}
        style={{ ...fieldInputStyle, padding: 'var(--space-2) var(--space-3)', resize: 'vertical', lineHeight: 1.4, ...inputStyle }}
        {...rest}
      />
    </FieldFrame>
  );
}

/** A checkbox with its label, a full tap target high. */
export function CheckboxField({ label, id, checked, onChange, hint }) {
  const fieldId = fieldIdOf(id, label);
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      <label htmlFor={fieldId} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', minHeight: 'var(--tap)', fontSize: 'var(--text-sm)', fontWeight: 600, cursor: 'pointer' }}>
        <input id={fieldId} type="checkbox" checked={Boolean(checked)} onChange={(e) => onChange(e.target.checked)} style={{ width: 20, height: 20, margin: 0 }} />
        {label}
      </label>
      {hint ? <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{hint}</span> : null}
    </div>
  );
}

/**
 * A dialog for a short form: a sheet from the bottom on phones, a centred panel on wider
 * screens (ui.css). Escape, a tap outside or the close button call onClose (which may ask first); the page behind doesn't scroll
 * while it is open. `footer` (the buttons) stays visible at the bottom while the body scrolls.
 * Wrap body + footer in a <form> by passing `onSubmit`.
 */
export function Sheet({ title, onClose, onSubmit, children, footer, testId }) {
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && close.current?.();
    document.addEventListener('keydown', onKey);
    const body = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = body;
    };
  }, []);
  const Inner = onSubmit ? 'form' : 'div';
  return (
    <div className="ui-sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="ui-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId}>
        <Inner
          className="ui-sheet-inner"
          {...(onSubmit ? { onSubmit: (e) => { e.preventDefault(); onSubmit(e); }, noValidate: true } : {})}
        >
          <header className="ui-sheet-header">
            <h2 id={titleId} style={{ fontSize: 'var(--text-lg)', fontWeight: 650, flex: 1, minWidth: 0 }}>{title}</h2>
            <button type="button" className="ui-sheet-close" onClick={onClose} aria-label="Close">
              <Icon name="close" size={20} />
            </button>
          </header>
          <div className="ui-sheet-body">{children}</div>
          {footer ? <footer className="ui-sheet-footer">{footer}</footer> : null}
        </Inner>
      </div>
    </div>
  );
}
