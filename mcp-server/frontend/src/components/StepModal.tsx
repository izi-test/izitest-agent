import { useEffect, useMemo, useState } from 'react';
import type { SharedElement, Step } from '../types';
import { useAppDispatch } from '../store/hooks';
import { showToast } from '../store/slices/uiSlice';
import { useAddStepMutation, useUpdateStepMutation } from '../store/services/testsApi';
import { projectsApi } from '../store/services/projectsApi';
import { Button } from './Button';
import { SharedUses } from './SharedUses';
import { usesCount } from '../uses';
import { Segmented } from './ui';
import { X, Save } from 'lucide-react';

// The parameters a server step starts from (mcp-server/lib/server-steps.js): a value kept for
// the steps after, written {{order}} there; an API called to prepare data.
const PARAMS_EXAMPLES: Record<string, object> = {
  capture: { what: 'text', selector: '#order-number', pattern: '#(\\d+)', name: 'order' },
  http: { method: 'POST', url: 'https://staging.example.com/api/users', body: '{"email": "user-{{unique}}@example.com"}' },
};

// The commands that act on an element: its target is picked among the project's elements, or
// written as selectors.
const ON_ELEMENT = new Set(['click', 'fill', 'select_option', 'hover', 'wait', 'scroll']);

/** An element of the project (mcp-server/lib/element-store.js), with how the latest step found it. */
interface ProjectElement {
  id: number;
  name: string;
  page: string;
  target: string;
  selector?: string;
  locators?: Array<{ type: string; value: string }>;
}

/** A business step of the project (mcp-server/lib/business-play.js). */
interface BusinessStep {
  id: number;
  keyword: string;
  pattern: string;
  steps: number;
  parameters: string[];
}

interface StepModalProps {
  isOpen: boolean;
  testName: string;
  /** The project of the test: its elements and its business steps are offered. */
  projectId?: number | null;
  step: Step | null;
  onClose: () => void;
  onSaved: () => void;
}

/** A wait's own time in the step's params (ms), as seconds; '' without one, or unreadable params. */
function waitSecondsOf(params: string): string {
  try {
    const timeout = Number(JSON.parse(params || '{}')?.timeout);
    return timeout > 0 ? String(timeout / 1000) : '';
  } catch { return ''; }
}

/** The step's params with the wait's own time set to `seconds`, or taken out when empty; null for unreadable params. */
function withWaitSeconds(params: string, seconds: string): string | null {
  let current: Record<string, unknown>;
  try { current = JSON.parse(params || '{}'); } catch { return null; }
  const next: Record<string, unknown> = { ...current };
  const value = Number(seconds);
  if (seconds.trim() && value > 0) next.timeout = Math.round(value * 1000);
  else delete next.timeout;
  return JSON.stringify(next, null, 2);
}

/** The phrase of a business step with its values: each {string} quoted, the rest as typed. */
function phraseOf(pattern: string, values: string[]): string {
  let i = 0;
  return pattern.replace(/\{([a-z]*)\}/g, (_, type: string) => {
    const value = values[i++] ?? '';
    return type === 'string' || type === '' ? `"${value.replace(/"/g, '\\"')}"` : value;
  });
}

const shortPage = (page: string) => page.replace(/^[^/]+/, '') || '/';

export function StepModal({ isOpen, testName, projectId, step, onClose, onSaved }: StepModalProps) {
  const dispatch = useAppDispatch();
  const [addStep] = useAddStepMutation();
  const [updateStep] = useUpdateStepMutation();

  const [mode, setMode] = useState<'action' | 'business'>('action');
  const [command, setCommand] = useState('navigate');
  const [intent, setIntent] = useState('');
  const [params, setParams] = useState('');
  const [locators, setLocators] = useState('');
  const [variable, setVariable] = useState('');
  const [elementId, setElementId] = useState('');
  const [elementQuery, setElementQuery] = useState('');
  const [elements, setElements] = useState<ProjectElement[]>([]);
  const [business, setBusiness] = useState<BusinessStep[]>([]);
  const [businessId, setBusinessId] = useState('');
  const [businessValues, setBusinessValues] = useState<string[]>([]);
  const [position, setPosition] = useState('');
  const [saving, setSaving] = useState(false);
  // The other steps acting on the element this one acts on, and whether its new locators go to them.
  const [shared, setShared] = useState<SharedElement | null>(null);
  const [applyToUses, setApplyToUses] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setMode('action');
      setCommand(step?.command || 'navigate');
      setIntent(step?.intent || '');

      const p = step ? (typeof step.params === 'string' ? step.params : JSON.stringify(step.params || {}, null, 2)) : '{}';
      const l = step?.locators ? (typeof step.locators === 'string' ? step.locators : JSON.stringify(step.locators, null, 2)) : '';
      const v = step?.variable ? (typeof step.variable === 'string' ? step.variable : JSON.stringify(step.variable, null, 2)) : '';

      setParams(p);
      setLocators(l);
      setVariable(v);
      setElementId('');
      setElementQuery('');
      setBusinessId('');
      setBusinessValues([]);
      setPosition('');
      setApplyToUses(false);
    }
  }, [isOpen, step]);

  // A step edited: which other steps act on its element (mcp-server/lib/element-store.js).
  useEffect(() => {
    setShared(null);
    if (!isOpen || !step) return;
    let gone = false;
    fetch(`/api/tests/${encodeURIComponent(testName)}/steps/${step.step_order}/uses`).then((r) => (r.ok ? r.json() : null))
      .then((d: SharedElement | null) => { if (!gone && d?.element && d.uses.length) setShared(d); }).catch(() => {});
    return () => { gone = true; };
  }, [isOpen, step, testName]);

  // The project's elements and business steps, read when the editor opens.
  useEffect(() => {
    if (!isOpen || !projectId) { setElements([]); setBusiness([]); return; }
    let gone = false;
    fetch(`/api/projects/${projectId}/elements`).then((r) => (r.ok ? r.json() : { elements: [] }))
      .then((d) => { if (!gone) setElements((d.elements ?? []).filter((e: ProjectElement) => e.selector)); }).catch(() => {});
    fetch(`/api/projects/${projectId}/business-steps`).then((r) => (r.ok ? r.json() : { business_steps: [] }))
      .then((d) => { if (!gone) setBusiness(d.business_steps ?? []); }).catch(() => {});
    return () => { gone = true; };
  }, [isOpen, projectId]);

  const shownElements = useMemo(() => {
    const q = elementQuery.trim().toLowerCase();
    return q ? elements.filter((e) => `${e.name} ${e.page} ${e.target}`.toLowerCase().includes(q)) : elements;
  }, [elements, elementQuery]);
  const byPage = useMemo(() => {
    const groups = new Map<string, ProjectElement[]>();
    for (const e of shownElements) groups.set(e.page, [...(groups.get(e.page) ?? []), e]);
    return [...groups];
  }, [shownElements]);
  const chosenBusiness = business.find((b) => String(b.id) === businessId) ?? null;

  if (!isOpen) return null;

  // A wait of a time (params.ms) waits that time: no time of its own to give.
  const waitIsPause = (() => { try { return Number(JSON.parse(params || '{}')?.ms) > 0; } catch { return false; } })();

  /** Picking an element writes its selector into the parameters and its locators below. */
  const pickElement = (id: string) => {
    setElementId(id);
    const element = elements.find((e) => String(e.id) === id);
    if (!element) return;
    let current: Record<string, unknown> = {};
    try { current = JSON.parse(params || '{}'); } catch { /* replaced below */ }
    const next: Record<string, unknown> = { ...current, selector: element.selector };
    // A wait for an element waits for it, not for a time.
    if (command === 'wait') delete next.ms;
    setParams(JSON.stringify(next, null, 2));
    setLocators(element.locators?.length ? JSON.stringify(element.locators, null, 2) : '');
    if (!intent.trim()) {
      const verb = command === 'click' ? 'Click' : command === 'fill' ? 'Fill' : command === 'wait' ? 'Wait for' : command === 'hover' ? 'Hover' : command === 'select_option' ? 'Choose in' : 'Scroll to';
      setIntent(`${verb} "${element.name}"`);
    }
  };

  const saveBusiness = async () => {
    if (!chosenBusiness) return dispatch(showToast({ message: 'Choose a business step', type: 'error' }));
    setSaving(true);
    try {
      const res = await fetch(`/api/tests/${encodeURIComponent(testName)}/steps/business`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phrase: phraseOf(chosenBusiness.pattern, businessValues), ...(position.trim() ? { step_order: Number(position) } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `The server answered ${res.status}`);
      dispatch(showToast({ message: `Business step added: ${body.count} steps from step ${body.from}` }));
      onSaved();
    } catch (err) {
      dispatch(showToast({ message: err instanceof Error ? err.message : 'Save failed', type: 'error' }));
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    if (mode === 'business') return saveBusiness();
    let parsedParams, parsedLocators, parsedVariable;
    try {
      parsedParams = JSON.parse(params || '{}');
    } catch { return dispatch(showToast({ message: 'Invalid JSON in Params', type: 'error' })); }

    try {
      parsedLocators = locators.trim() ? JSON.parse(locators) : null;
    } catch { return dispatch(showToast({ message: 'Invalid JSON in Locators', type: 'error' })); }

    try {
      parsedVariable = variable.trim() ? JSON.parse(variable) : null;
    } catch { return dispatch(showToast({ message: 'Invalid JSON in Variable', type: 'error' })); }

    const body = {
      command, intent: intent || null, params: parsedParams, locators: parsedLocators, variable: parsedVariable,
      ...(!step && position.trim() ? { step_order: Number(position) } : {}),
      ...(step && shared && applyToUses ? { apply_to_uses: true } : {}),
    };

    try {
      if (step) {
        const { relocated = [] } = await updateStep({ testName, stepOrder: step.step_order, body }).unwrap() ?? {};
        dispatch(showToast({ message: relocated.length ? `Step updated, and ${usesCount(relocated)} acting on the same element` : 'Step updated' }));
        if (relocated.length) dispatch(projectsApi.util.invalidateTags(['Elements']));
      } else {
        await addStep({ testName, body }).unwrap();
        dispatch(showToast({ message: 'Step added' }));
      }
      onSaved();
    } catch (err: any) {
      dispatch(showToast({ message: err.message || 'Save failed', type: 'error' }));
    }
  };

  return (
    <div id="stepModal" className="modal">
      <div className="modal-overlay" onClick={onClose}></div>
      <div className="modal-content">
        <div className="modal-header">
          <h3 id="modalTitle">{step ? `Edit Step #${step.step_order}` : 'Add Step'}</h3>
          <button className="btn-close" onClick={onClose}><X size={20} /></button>
        </div>
        <div className="modal-body">
          {!step && (
            <div className="field-group">
              <Segmented
                label="What to add"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'action', label: 'An action' },
                  { value: 'business', label: 'A business step', count: business.length },
                ]}
              />
            </div>
          )}

          {mode === 'business' ? (
            business.length === 0 ? (
              <p className="help">
                This project has no business step yet. In a test's Gherkin tab, <em>Propose business steps</em> groups its steps into phrases
                (logging in, logging out…), which any test can then use.
              </p>
            ) : (
              <>
                <div className="field-group">
                  <label>Business step</label>
                  <select value={businessId} onChange={(e) => {
                    setBusinessId(e.target.value);
                    const b = business.find((x) => String(x.id) === e.target.value);
                    setBusinessValues(b ? b.parameters.map(() => '') : []);
                  }}>
                    <option value="">Choose…</option>
                    {business.map((b) => <option key={b.id} value={b.id}>{b.keyword} {b.pattern} — {b.steps} steps</option>)}
                  </select>
                </div>
                {chosenBusiness?.parameters.map((type, i) => (
                  <div className="field-group" key={i}>
                    <label>Value {i + 1} <span className="field__optional">{type}</span></label>
                    <input type="text" value={businessValues[i] ?? ''} placeholder={type === '{int}' ? '42' : 'a value, {{variable}} or {{secret.NAME}}'}
                      onChange={(e) => setBusinessValues(businessValues.map((v, j) => (j === i ? e.target.value : v)))} />
                  </div>
                ))}
                {chosenBusiness && (
                  <p className="help">
                    Reads: <strong>{chosenBusiness.keyword} {phraseOf(chosenBusiness.pattern, businessValues)}</strong>. Its {chosenBusiness.steps} steps are
                    inserted with their locators; the test reads as this phrase.
                  </p>
                )}
                <div className="field-group">
                  <label>At step <span className="field__optional">empty: at the end</span></label>
                  <input type="number" min={1} value={position} onChange={(e) => setPosition(e.target.value)} style={{ width: 120 }} />
                </div>
              </>
            )
          ) : (
            <>
              <div className="field-group">
                <label>Command</label>
                <select value={command} onChange={e => {
                  setCommand(e.target.value);
                  const example = PARAMS_EXAMPLES[e.target.value];
                  if (example && !params.replace(/[\s{}]/g, '')) setParams(JSON.stringify(example, null, 2));
                }}>
                  <option value="navigate">navigate</option>
                  <option value="click">click</option>
                  <option value="fill">fill</option>
                  <option value="select_option">select_option</option>
                  <option value="hover">hover</option>
                  <option value="scroll">scroll</option>
                  <option value="wait">wait</option>
                  <option value="press_key">press_key</option>
                  <option value="snapshot">snapshot</option>
                  <option value="screenshot">screenshot</option>
                  <option value="capture">capture — keep a value as {'{{name}}'}</option>
                  <option value="http">http — call an API</option>
                </select>
              </div>
              {ON_ELEMENT.has(command) && projectId && (
                <div className="field-group">
                  <label>Element of the project <span className="field__optional">or write the selector below</span></label>
                  {elements.length > 8 && (
                    <input type="search" value={elementQuery} onChange={(e) => setElementQuery(e.target.value)} placeholder="Search an element…" style={{ marginBottom: 6 }} />
                  )}
                  <select value={elementId} onChange={(e) => pickElement(e.target.value)}>
                    <option value="">{elements.length ? 'Choose an element…' : 'No element recorded yet in this project'}</option>
                    {byPage.map(([page, list]) => (
                      <optgroup key={page} label={shortPage(page)}>
                        {list.map((el) => <option key={el.id} value={el.id}>{el.name} — {el.target}</option>)}
                      </optgroup>
                    ))}
                  </select>
                  {command === 'wait' && <span className="field__hint">Waiting for an element is better than waiting a time: the replay goes on as soon as it shows.</span>}
                </div>
              )}
              {command === 'wait' && !waitIsPause && (
                <div className="field-group">
                  <label htmlFor="step-wait-timeout">Wait at most <span className="field__optional">seconds — empty: as long as the project waits for an element</span></label>
                  <input
                    id="step-wait-timeout" type="number" min={1} max={300} step={1} style={{ width: 120 }}
                    value={waitSecondsOf(params)}
                    onChange={(e) => { const next = withWaitSeconds(params, e.target.value); if (next != null) setParams(next); }}
                  />
                  <span className="field__hint">For what takes longer than the other steps' elements: an export built, a report computed. From 1 s to 5 min.</span>
                </div>
              )}
              <div className="field-group">
                <label>Intent</label>
                <input type="text" value={intent} onChange={e => setIntent(e.target.value)} placeholder="What this step does..." />
              </div>
              <div className="field-group">
                <label>Params (JSON)</label>
                <textarea rows={5} value={params} onChange={e => { setParams(e.target.value); setElementId(''); }} placeholder='{"url": "https://..."}'></textarea>
              </div>
              <div className="field-group">
                <label>Locators (JSON, optional)</label>
                <textarea rows={3} value={locators} onChange={e => setLocators(e.target.value)} placeholder='[{"type": "css", "value": "#btn"}]'></textarea>
              </div>
              {step && shared && (
                <SharedUses
                  shared={shared}
                  check={{
                    label: 'Give them this step\'s selector and locators too — the same element, found another way',
                    checked: applyToUses,
                    onChange: setApplyToUses,
                  }}
                />
              )}
              <div className="field-group">
                <label>Variable (JSON, optional)</label>
                <textarea rows={3} value={variable} onChange={e => setVariable(e.target.value)} placeholder='{"name": "query", "type": "text", "defaultValue": ""}'></textarea>
              </div>
              {!step && (
                <div className="field-group">
                  <label>At step <span className="field__optional">empty: at the end</span></label>
                  <input type="number" min={1} value={position} onChange={(e) => setPosition(e.target.value)} style={{ width: 120 }} />
                </div>
              )}
            </>
          )}
        </div>
        <div className="modal-footer">
          <Button variant="cancel" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" icon={Save} onClick={handleSave} disabled={saving || (mode === 'business' && !chosenBusiness)}>
            {mode === 'business' ? 'Add the business step' : 'Save Step'}
          </Button>
        </div>
      </div>
    </div>
  );
}
