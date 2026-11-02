import { useEffect, useRef, useState, type ElementType, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal, X } from 'lucide-react';
import type { Project } from '../types';
import { STATUS_TONES, initialsOf, type Tone } from '../format';

// The pieces every page is made of, in the blue and white theme (index.css): a page's header, a
// card, a status pill whose colour means the same everywhere, a project's avatar and chip, a
// segmented filter, a menu, a drawer, an empty state.

// ─── Status ──────────────────────────────────────────────────────────

export function Pill({ tone = 'slate', dot = true, children, title, className = '' }: {
  tone?: Tone; dot?: boolean; children: ReactNode; title?: string; className?: string;
}) {
  return (
    <span className={`pill pill--${tone} ${className}`.trim()} title={title}>
      {dot && <span className="pill__dot" />}
      {children}
    </span>
  );
}

/** A status as a pill: "Passed", "Failed", "Never run"… A label replaces the usual one. */
export function StatusPill({ status, label, icon: Icon }: { status: string | null | undefined; label?: ReactNode; icon?: ElementType }) {
  const [tone, text] = STATUS_TONES[status ?? 'never'] ?? ['slate', status];
  return (
    <Pill tone={tone} dot={!Icon}>
      {Icon && <Icon size={12} className={status === 'running' ? 'spin' : undefined} />}
      {label ?? text}
    </Pill>
  );
}

/** The share of each result of a campaign, as a bar. */
export function ResultBar({ totals }: { totals: Partial<Record<'passed' | 'failed' | 'error' | 'running' | 'pending' | 'skipped', number>> }) {
  const parts = [['passed', 'green'], ['failed', 'red'], ['error', 'amber'], ['running', 'blue'], ['pending', 'slate'], ['skipped', 'slate']] as const;
  return (
    <div className="result-bar" title={parts.filter(([s]) => totals[s]).map(([s]) => `${totals[s]} ${s}`).join(', ')}>
      {parts.filter(([s]) => totals[s]).map(([s, tone]) => <span key={s} className={`result-bar__part bar--${tone}`} style={{ flexGrow: totals[s] }} />)}
    </div>
  );
}

// ─── Projects ────────────────────────────────────────────────────────

const AVATAR_COLORS = ['#2563EB', '#0891B2', '#4F46E5', '#0D9488', '#1E40AF', '#0369A1', '#7C3AED', '#475569'];

export function ProjectAvatar({ project, size = 24 }: { project: Pick<Project, 'id' | 'name'>; size?: number }) {
  return (
    <span
      className="project-avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: AVATAR_COLORS[project.id % AVATAR_COLORS.length] }}
      aria-hidden
    >
      {initialsOf(project.name)}
    </span>
  );
}

/** A project, named with its avatar: a link to it when `onClick` is given. */
export function ProjectChip({ project, onClick, title }: { project: Pick<Project, 'id' | 'name'> | null | undefined; onClick?: () => void; title?: string }) {
  if (!project) return <span className="chip chip--muted">No project</span>;
  const body = <><ProjectAvatar project={project} size={16} /> {project.name}</>;
  return onClick
    ? <button type="button" className="chip chip--link" onClick={onClick} title={title ?? `Open ${project.name}`}>{body}</button>
    : <span className="chip">{body}</span>;
}

/** A requirement's key, as a chip: a link to it when `onClick` is given. */
export function KeyChip({ children, onClick, title }: { children: ReactNode; onClick?: () => void; title?: string }) {
  return onClick
    ? <button type="button" className="key-chip key-chip--link" onClick={(e) => { e.stopPropagation(); onClick(); }} title={title}>{children}</button>
    : <span className="key-chip" title={title}>{children}</span>;
}

// ─── Layout ──────────────────────────────────────────────────────────

export function PageHeader({ title, subtitle, actions, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-header">
      <div className="page-header__text">
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
        {children}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </div>
  );
}

export function Card({ title, icon: Icon, actions, children, className = '', flush = false, subtitle, id }: {
  title?: ReactNode; icon?: ElementType; actions?: ReactNode; children?: ReactNode; className?: string; flush?: boolean; subtitle?: ReactNode; id?: string;
}) {
  return (
    <section id={id} className={`card ${flush ? 'card--flush' : ''} ${className}`.trim()}>
      {(title || actions) && (
        <header className="card__header">
          <div className="card__heading">
            {title && <h2 className="card__title">{Icon && <Icon size={16} />}{title}</h2>}
            {subtitle && <p className="card__subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="card__actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ icon: Icon, title, children, action }: { icon?: ElementType; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {Icon && <span className="empty__icon"><Icon size={22} /></span>}
      <p className="empty__title">{title}</p>
      {children && <p className="empty__text">{children}</p>}
      {action}
    </div>
  );
}

/** A choice among a few, as joined buttons, each with its count when given. */
export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: Array<{ value: T; label: ReactNode; count?: number; tone?: Tone }>; value: T; onChange: (value: T) => void; label?: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value} type="button" role="radio" aria-checked={value === o.value}
          className={`segmented__option ${value === o.value ? 'active' : ''}`} onClick={() => onChange(o.value)}
        >
          {o.tone && <span className={`segmented__dot pill--${o.tone}`} />}
          {o.label}
          {o.count !== undefined && <span className="segmented__count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ─── Menus, drawers ──────────────────────────────────────────────────

export type MenuItem = { label: ReactNode; icon?: ElementType; onClick: () => void; danger?: boolean; disabled?: boolean } | 'divider';

/** A "⋯" button and the actions it opens. */
export function Menu({ items, label = 'More actions', trigger }: { items: MenuItem[]; label?: string; trigger?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button type="button" className={trigger ? 'btn btn--secondary' : 'icon-button'} aria-label={label} title={label} aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
        {trigger ?? <MoreHorizontal size={16} />}
      </button>
      {open && (
        <div className="menu__list" role="menu" onClick={(e) => e.stopPropagation()}>
          {items.map((item, i) => item === 'divider' ? <div key={i} className="menu__divider" /> : (
            <button key={i} type="button" role="menuitem" disabled={item.disabled}
              className={`menu__item ${item.danger ? 'menu__item--danger' : ''}`}
              onClick={() => { setOpen(false); item.onClick(); }}>
              {item.icon && <item.icon size={14} />}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A panel sliding in from the right, over the page. */
export function Drawer({ title, onClose, children, footer, width = 480 }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);
  return createPortal(
    <div className="drawer-layer">
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" style={{ width }} role="dialog" aria-modal aria-label={typeof title === 'string' ? title : undefined}>
        <header className="drawer__header">
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="drawer__body">{children}</div>
        {footer && <footer className="drawer__footer">{footer}</footer>}
      </aside>
    </div>,
    document.body,
  );
}

/** A dialog in the middle of the page. */
export function Dialog({ title, onClose, children, footer, width = 560, icon }: {
  title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number; icon?: ReactNode;
}) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);
  return createPortal(
    <div className="dialog-layer" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" style={{ width }} role="dialog" aria-modal aria-label={typeof title === 'string' ? title : undefined}>
        <header className="dialog__header">
          {icon}
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="dialog__body">{children}</div>
        {footer && <footer className="dialog__footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
