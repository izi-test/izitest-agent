import { useEffect, useState } from 'react';
import { FileCode, Save, RotateCcw } from 'lucide-react';
import { Button } from './Button';
import {
  useGetTestFeatureQuery,
  usePutTestFeatureMutation,
} from '../store/services/testsApi';
import { useAppDispatch } from '../store/hooks';
import { showToast } from '../store/slices/uiSlice';

interface GherkinEditorProps {
  testName: string;
}

interface GherkinErrorBody {
  error?: string;
  errors?: string[];
}

export function GherkinEditor({ testName }: GherkinEditorProps) {
  const dispatch = useAppDispatch();
  const { data: serverFeature, isLoading, isError, error, refetch } =
    useGetTestFeatureQuery(testName);
  const [putFeature, { isLoading: isSaving }] = usePutTestFeatureMutation();

  const [draft, setDraft] = useState('');
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  useEffect(() => {
    if (typeof serverFeature === 'string') {
      setDraft(serverFeature);
      setValidationErrors([]);
    }
  }, [serverFeature]);

  const isDirty = typeof serverFeature === 'string' && draft !== serverFeature;

  async function handleSave() {
    setValidationErrors([]);
    try {
      await putFeature({ testName, feature: draft }).unwrap();
      dispatch(showToast({ message: 'Gherkin saved', type: 'success' }));
    } catch (err) {
      const body = (err as { data?: GherkinErrorBody })?.data;
      if (body?.errors?.length) {
        setValidationErrors(body.errors);
      } else {
        const message = body?.error || 'Failed to save Gherkin';
        setValidationErrors([message]);
      }
      dispatch(showToast({ message: 'Failed to save Gherkin', type: 'error' }));
    }
  }

  function handleRevert() {
    if (typeof serverFeature === 'string') {
      setDraft(serverFeature);
      setValidationErrors([]);
    }
  }

  if (isLoading) {
    return <div className="gherkin-editor gherkin-editor--state">Loading Gherkin…</div>;
  }

  if (isError) {
    const body = (error as { data?: GherkinErrorBody })?.data;
    const message = body?.error || 'Failed to load Gherkin. Assign the test to a project first.';
    return (
      <div className="gherkin-editor gherkin-editor--state">
        <div className="gherkin-error">{message}</div>
        <Button variant="action" size="sm" onClick={() => refetch()}>Retry</Button>
      </div>
    );
  }

  return (
    <div className="gherkin-editor">
      <div className="gherkin-editor__header">
        <div className="gherkin-editor__title">
          <FileCode size={16} />
          <span>Gherkin (.feature)</span>
        </div>
        <div className="gherkin-editor__actions">
          <Button
            variant="cancel"
            size="sm"
            icon={RotateCcw}
            onClick={handleRevert}
            disabled={!isDirty || isSaving}
          >
            Revert
          </Button>
          <Button
            variant="save"
            size="sm"
            icon={Save}
            onClick={handleSave}
            disabled={!isDirty || isSaving}
          >
            {isSaving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      <textarea
        className="gherkin-textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        placeholder="Feature: ..."
      />

      {validationErrors.length > 0 && (
        <div className="gherkin-error">
          <strong>Gherkin could not be parsed:</strong>
          <ul>
            {validationErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
