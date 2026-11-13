import type { ReactNode } from 'react';
import { Link2 } from 'lucide-react';
import type { SharedElement } from '../types';
import { plural } from '../uses';

// The other steps of the project acting on the element a step acts on (mcp-server/lib/
// element-store.js): each step keeps its own copy of how it finds it, so a fix made to one is
// offered to them all — a repair, an edit in the step editor.

interface SharedUsesProps {
  shared: SharedElement;
  /** The checkbox: what checking it does, its state. None: `children` say what can be done. */
  check?: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean };
  children?: ReactNode;
}

export function SharedUses({ shared, check, children }: SharedUsesProps) {
  const byTest = new Map<string, number[]>();
  for (const use of shared.uses) byTest.set(use.test, [...(byTest.get(use.test) ?? []), use.step_order]);

  return (
    <div className="shared-uses">
      <div className="shared-uses__head">
        <Link2 size={12} />
        <span>
          “{shared.element.name}” is also used by <strong>{plural(shared.uses.length, 'step')} in {plural(shared.tests, 'test')}</strong>
        </span>
      </div>
      <ul className="shared-uses__list">
        {[...byTest].map(([test, orders]) => (
          <li key={test}><span className="shared-uses__test">{test}</span> · {orders.length === 1 ? 'step' : 'steps'} {orders.join(', ')}</li>
        ))}
      </ul>
      {check && (
        <label className="checkbox-row shared-uses__check">
          <input type="checkbox" checked={check.checked} disabled={check.disabled} onChange={(e) => check.onChange(e.target.checked)} />
          <span>{check.label}</span>
        </label>
      )}
      {children}
    </div>
  );
}
