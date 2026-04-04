import { useEffect, useState } from 'react';
import type { Step } from '../types';
import { api } from '../api';
import { useAppContext } from '../context/AppContext';
import { Button } from './Button';
import { X, Save } from 'lucide-react';

interface StepModalProps {
  isOpen: boolean;
  workflowName: string;
  step: Step | null;
  onClose: () => void;
  onSaved: () => void;
}

export function StepModal({ isOpen, workflowName, step, onClose, onSaved }: StepModalProps) {
  const { showToast } = useAppContext();
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
    } catch { return showToast('Invalid JSON in Params', 'error'); }

    try {
      parsedLocators = locators.trim() ? JSON.parse(locators) : null;
    } catch { return showToast('Invalid JSON in Locators', 'error'); }

    try {
      parsedVariable = variable.trim() ? JSON.parse(variable) : null;
    } catch { return showToast('Invalid JSON in Variable', 'error'); }

    const body = { command, intent: intent || null, params: parsedParams, locators: parsedLocators, variable: parsedVariable };

    try {
      if (step) {
        await api('PUT', `/api/workflows/${encodeURIComponent(workflowName)}/steps/${step.step_order}`, body);
        showToast('Step updated');
      } else {
        await api('POST', `/api/workflows/${encodeURIComponent(workflowName)}/steps`, body);
        showToast('Step added');
      }
      onSaved();
    } catch (err: any) {
      showToast(err.message, 'error');
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
            <select value={command} onChange={e => setCommand(e.target.value)}>
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
