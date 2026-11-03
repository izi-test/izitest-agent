import { useEffect, useState } from 'react';
import type { Step } from '../types';
import { useAppDispatch } from '../store/hooks';
import { showToast } from '../store/slices/uiSlice';
import { useAddStepMutation, useUpdateStepMutation } from '../store/services/testsApi';
import { Button } from './Button';
import { X, Save } from 'lucide-react';

// The parameters a server step starts from (mcp-server/lib/server-steps.js): a value kept for
// the steps after, written {{order}} there; an API called to prepare data.
const PARAMS_EXAMPLES: Record<string, object> = {
  capture: { what: 'text', selector: '#order-number', pattern: '#(\\d+)', name: 'order' },
  http: { method: 'POST', url: 'https://staging.example.com/api/users', body: '{"email": "user-{{unique}}@example.com"}' },
};

interface StepModalProps {
  isOpen: boolean;
  testName: string;
  step: Step | null;
  onClose: () => void;
  onSaved: () => void;
}

export function StepModal({ isOpen, testName, step, onClose, onSaved }: StepModalProps) {
  const dispatch = useAppDispatch();
  const [addStep] = useAddStepMutation();
  const [updateStep] = useUpdateStepMutation();

  const [command, setCommand] = useState('navigate');
  const [intent, setIntent] = useState('');
  const [params, setParams] = useState('');
  const [locators, setLocators] = useState('');
  const [variable, setVariable] = useState('');

  useEffect(() => {
    if (isOpen) {
      setCommand(step?.command || 'navigate');
      setIntent(step?.intent || '');

      const p = step ? (typeof step.params === 'string' ? step.params : JSON.stringify(step.params || {}, null, 2)) : '{}';
      const l = step?.locators ? (typeof step.locators === 'string' ? step.locators : JSON.stringify(step.locators, null, 2)) : '';
      const v = step?.variable ? (typeof step.variable === 'string' ? step.variable : JSON.stringify(step.variable, null, 2)) : '';

      setParams(p);
      setLocators(l);
      setVariable(v);
    }
  }, [isOpen, step]);

  if (!isOpen) return null;

  const handleSave = async () => {
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

    const body = { command, intent: intent || null, params: parsedParams, locators: parsedLocators, variable: parsedVariable };

    try {
      if (step) {
        await updateStep({ testName, stepOrder: step.step_order, body }).unwrap();
        dispatch(showToast({ message: 'Step updated' }));
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
          <div className="field-group">
            <label>Intent</label>
            <input type="text" value={intent} onChange={e => setIntent(e.target.value)} placeholder="What this step does..." />
          </div>
          <div className="field-group">
            <label>Params (JSON)</label>
            <textarea rows={5} value={params} onChange={e => setParams(e.target.value)} placeholder='{"url": "https://..."}'></textarea>
          </div>
          <div className="field-group">
            <label>Locators (JSON, optional)</label>
            <textarea rows={3} value={locators} onChange={e => setLocators(e.target.value)} placeholder='[{"type": "css", "value": "#btn"}]'></textarea>
          </div>
          <div className="field-group">
            <label>Variable (JSON, optional)</label>
            <textarea rows={3} value={variable} onChange={e => setVariable(e.target.value)} placeholder='{"name": "query", "type": "text", "defaultValue": ""}'></textarea>
          </div>
        </div>
        <div className="modal-footer">
          <Button variant="cancel" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" icon={Save} onClick={handleSave}>Save Step</Button>
        </div>
      </div>
    </div>
  );
}
