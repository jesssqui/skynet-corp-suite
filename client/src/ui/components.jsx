// Shared building blocks. Every module uses these instead of styling its own,
// so the suite looks like one app. Styles are inline and use the theme tokens.

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
      {actions ? <div style={{ display: 'flex', gap: 'var(--space-2)' }}>{actions}</div> : null}
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
