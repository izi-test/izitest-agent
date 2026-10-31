import { useEffect, useState } from 'react';
import type { Step } from '../types';
import { useAppDispatch } from '../store/hooks';
import { showToast } from '../store/slices/uiSlice';
import { useAddStepMutation, useUpdateStepMutation } from '../store/services/testsApi';
import { Button } from './Button';
import { X, Save, ShieldCheck } from 'lucide-react';

const ASSERTION_TYPES = [
  { value: 'element_exists', label: 'Element Exists', needsSelector: true, needsExpected: false },
  { value: 'element_not_exists', label: 'Element Not Exists', needsSelector: true, needsExpected: false },
  { value: 'element_visible', label: 'Element Visible', needsSelector: true, needsExpected: false },
  { value: 'element_hidden', label: 'Element Hidden', needsSelector: true, needsExpected: false },
  { value: 'text_equals', label: 'Text Equals', needsSelector: true, needsExpected: true },
  { value: 'text_contains', label: 'Text Contains', needsSelector: true, needsExpected: true },
  { value: 'text_not_contains', label: 'Text Does Not Contain', needsSelector: true, needsExpected: true },
  { value: 'attribute_equals', label: 'Attribute Equals', needsSelector: true, needsExpected: true, needsAttribute: true },
  { value: 'url_equals', label: 'URL Equals', needsSelector: false, needsExpected: true },
  { value: 'url_contains', label: 'URL Contains', needsSelector: false, needsExpected: true },
  { value: 'title_equals', label: 'Page Title Equals', needsSelector: false, needsExpected: true },
  { value: 'title_contains', label: 'Page Title Contains', needsSelector: false, needsExpected: true },
  { value: 'element_count', label: 'Element Count', needsSelector: true, needsExpected: true },
  { value: 'visual_match', label: 'Visual Match (VRT)', needsSelector: false, needsExpected: true },
];

interface AssertionModalProps {
  isOpen: boolean;
  testName: string;
  step: Step | null;
  onClose: () => void;
  onSaved: () => void;
}

export function AssertionModal({ isOpen, testName, step, onClose, onSaved }: AssertionModalProps) {
  const dispatch = useAppDispatch();
  const [addStep] = useAddStepMutation();
  const [updateStep] = useUpdateStepMutation();

  const [assertionType, setAssertionType] = useState('element_exists');
  const [selector, setSelector] = useState('');
  const [expected, setExpected] = useState('');
  const [attribute, setAttribute] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (isOpen) {
      if (step?.assertion) {
        const a = typeof step.assertion === 'string' ? JSON.parse(step.assertion) : step.assertion;
        setAssertionType(a.type || 'element_exists');
        setSelector(a.selector || '');
        setExpected(a.expected || '');
        setAttribute(a.attribute || '');
        setDescription(step.intent || '');
      } else {
        setAssertionType('element_exists');
        setSelector('');
        setExpected('');
        setAttribute('');
        setDescription('');
      }
    }
  }, [isOpen, step]);

  if (!isOpen) return null;

  const typeConfig = ASSERTION_TYPES.find(t => t.value === assertionType);

  const handleSave = async () => {
    if (typeConfig?.needsSelector && !selector.trim()) {
      return dispatch(showToast({ message: 'CSS selector is required', type: 'error' }));
    }
    if (typeConfig?.needsExpected && !expected.trim()) {
      return dispatch(showToast({ message: 'Expected value is required', type: 'error' }));
    }
    if (typeConfig?.needsAttribute && !attribute.trim()) {
      return dispatch(showToast({ message: 'Attribute name is required', type: 'error' }));
    }

    const assertion: any = { type: assertionType };
    if (typeConfig?.needsSelector) assertion.selector = selector.trim();
    if (typeConfig?.needsExpected) assertion.expected = expected.trim();
    if (typeConfig?.needsAttribute) assertion.attribute = attribute.trim();

    const intent = description.trim() || `Assert: ${typeConfig?.label || assertionType}${selector ? ` on "${selector}"` : ''}${expected ? ` = "${expected}"` : ''}`;

    const body = {
      command: 'assert',
      intent,
      params: {},
      assertion,
    };

    try {
      if (step) {
        await updateStep({ testName, stepOrder: step.step_order, body }).unwrap();
        dispatch(showToast({ message: 'Assertion updated' }));
      } else {
        await addStep({ testName, body }).unwrap();
        dispatch(showToast({ message: 'Assertion added' }));
      }
      onSaved();
    } catch (err: any) {
      dispatch(showToast({ message: err.message || 'Save failed', type: 'error' }));
    }
  };

  return (
    <div className="modal">
      <div className="modal-overlay" onClick={onClose}></div>
      <div className="modal-content">
        <div className="modal-header">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ShieldCheck size={20} />
            {step ? `Edit Assertion #${step.step_order}` : 'Add Assertion'}
          </h3>
          <button className="btn-close" onClick={onClose}><X size={20} /></button>
        </div>
        <div className="modal-body">
          <div className="field-group">
            <label>Assertion Type</label>
            <select value={assertionType} onChange={e => setAssertionType(e.target.value)}>
              {ASSERTION_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          {typeConfig?.needsSelector && (
            <div className="field-group">
              <label>CSS Selector</label>
              <input
                type="text"
                value={selector}
                onChange={e => setSelector(e.target.value)}
                placeholder='e.g. #result, .success-message, [data-testid="output"]'
              />
            </div>
          )}

          {typeConfig?.needsAttribute && (
            <div className="field-group">
              <label>Attribute Name</label>
              <input
                type="text"
                value={attribute}
                onChange={e => setAttribute(e.target.value)}
                placeholder="e.g. href, class, data-status"
              />
            </div>
          )}

          {typeConfig?.needsExpected && (
            <div className="field-group">
              <label>Expected Value {assertionType === 'visual_match' && '(Baseline Path)'}</label>
              {assertionType === 'visual_match' ? (
                <>
                  <input
                    type="text"
                    value={expected}
                    onChange={e => setExpected(e.target.value)}
                    placeholder="data/baselines/baseline-id.png"
                    style={{ backgroundColor: '#1a1a1a', color: '#fff' }}
                  />
                  {expected && (
                    <div className="vrt-preview" style={{ marginTop: '8px' }}>
                      <span style={{ fontSize: '11px', color: '#888', display: 'block', marginBottom: '4px' }}>Visual Baseline Reference:</span>
                      <img src={`/${expected}`} alt="VRT baseline" style={{ maxWidth: '100%', maxHeight: '120px', borderRadius: '4px', border: '1px solid #333' }} />
                    </div>
                  )}
                </>
              ) : (
                <input
                  type="text"
                  value={expected}
                  onChange={e => setExpected(e.target.value)}
                  placeholder={assertionType === 'element_count' ? 'e.g. 5' : 'e.g. Success, Welcome...'}
                />
              )}
            </div>
          )}

          <div className="field-group">
            <label>Description (optional)</label>
            <input
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What this assertion verifies..."
            />
          </div>
        </div>
        <div className="modal-footer">
          <Button variant="cancel" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" icon={Save} onClick={handleSave}>
            {step ? 'Update Assertion' : 'Add Assertion'}
          </Button>
        </div>
      </div>
    </div>
  );
}
