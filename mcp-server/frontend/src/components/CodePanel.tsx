import { useMemo, useState } from 'react';
import JSZip from 'jszip';
import { Download, Copy, Loader2 } from 'lucide-react';
import Editor, { type Monaco } from '@monaco-editor/react';
import { Button } from './Button';
import { useGetTestCodegenQuery } from '../store/services/testsApi';
import { useAppDispatch } from '../store/hooks';
import { showToast } from '../store/slices/uiSlice';

function languageForPath(path: string): string {
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) return 'javascript';
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
  if (path.endsWith('.feature')) return 'gherkin';
  return 'plaintext';
}

// Monaco does not ship a Gherkin grammar — register a minimal Monarch tokenizer
// and a matching dark theme so .feature files get proper highlighting.
function registerGherkin(monaco: Monaco) {
  const existing = monaco.languages.getLanguages().some((l: { id: string }) => l.id === 'gherkin');
  if (existing) return;

  monaco.languages.register({ id: 'gherkin', extensions: ['.feature'], aliases: ['Gherkin', 'feature'] });

  monaco.languages.setMonarchTokensProvider('gherkin', {
    defaultToken: '',
    tokenPostfix: '.feature',
    keywords: [
      'Feature', 'Rule', 'Background', 'Scenario Outline', 'Scenario Template',
      'Scenario', 'Example', 'Examples',
    ],
    stepKeywords: ['Given', 'When', 'Then', 'And', 'But'],
    tokenizer: {
      root: [
        [/^\s*#.*$/, 'comment'],
        [/^\s*@[\w-]+/, 'tag'],
        [
          /^\s*(Feature|Rule|Background|Scenario Outline|Scenario Template|Scenario|Example|Examples):/,
          'keyword.section',
        ],
        [/^\s*(Given|When|Then|And|But|\*)\b/, 'keyword.step'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/<[^>]+>/, 'variable.parameter'],
        [/\{\{[^}]+\}\}/, 'variable.parameter'],
        [/\|/, 'delimiter'],
        [/\b\d+(\.\d+)?\b/, 'number'],
      ],
    },
  });

  monaco.editor.defineTheme('gherkin-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword.section', foreground: 'C586C0', fontStyle: 'bold' },
      { token: 'keyword.step', foreground: '569CD6', fontStyle: 'bold' },
      { token: 'string', foreground: 'CE9178' },
      { token: 'variable.parameter', foreground: '4FC1FF' },
      { token: 'tag', foreground: 'DCDCAA' },
      { token: 'comment', foreground: '6A9955', fontStyle: 'italic' },
      { token: 'number', foreground: 'B5CEA8' },
      { token: 'delimiter', foreground: '808080' },
    ],
    colors: {},
  });
}

type Framework = 'playwright-plain' | 'playwright-cucumber';

const FRAMEWORKS: { id: Framework; label: string; description: string }[] = [
  {
    id: 'playwright-plain',
    label: 'Playwright',
    description: 'Single @playwright/test spec file.',
  },
  {
    id: 'playwright-cucumber',
    label: 'Playwright + Cucumber',
    description: 'Feature file + step definitions + World.',
  },
];

interface CodePanelProps {
  testName: string;
}

export function CodePanel({ testName }: CodePanelProps) {
  const dispatch = useAppDispatch();
  const [framework, setFramework] = useState<Framework>('playwright-plain');

  const { data, isLoading, isError, error } = useGetTestCodegenQuery({
    testName,
    framework,
  });

  const files = data?.files || [];
  const [activePath, setActivePath] = useState<string | null>(null);

  const selectedPath = useMemo(() => {
    if (activePath && files.some((f) => f.path === activePath)) return activePath;
    return files[0]?.path ?? null;
  }, [activePath, files]);

  const selectedFile = files.find((f) => f.path === selectedPath) || null;

  async function handleCopy() {
    if (!selectedFile) return;
    try {
      await navigator.clipboard.writeText(selectedFile.content);
      dispatch(showToast({ message: 'Copied to clipboard' }));
    } catch {
      dispatch(showToast({ message: 'Clipboard access denied', type: 'error' }));
    }
  }

  async function handleDownloadZip() {
    if (!files.length) return;
    const zip = new JSZip();
    for (const f of files) zip.file(f.path, f.content);
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${testName}-${framework}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    dispatch(showToast({ message: 'Download started' }));
  }

  return (
    <div className="code-panel">
      <div className="code-panel__header">
        <div className="code-panel__frameworks" role="tablist">
          {FRAMEWORKS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={framework === f.id}
              className={`code-fw-btn ${framework === f.id ? 'active' : ''}`}
              onClick={() => { setFramework(f.id); setActivePath(null); }}
            >
              <strong>{f.label}</strong>
              <span>{f.description}</span>
            </button>
          ))}
        </div>

        <div className="code-panel__actions">
          <Button
            variant="cancel"
            size="sm"
            icon={Copy}
            onClick={handleCopy}
            disabled={!selectedFile}
          >
            Copy file
          </Button>
          <Button
            variant="save"
            size="sm"
            icon={Download}
            onClick={handleDownloadZip}
            disabled={!files.length}
          >
            Download .zip
          </Button>
        </div>
      </div>

      {isLoading && (
        <div className="code-panel__state">
          <Loader2 size={16} className="spin" /> Generating code…
        </div>
      )}

      {isError && (
        <div className="code-panel__error">
          {(error as { data?: { error?: string } })?.data?.error || 'Failed to generate code'}
        </div>
      )}

      {!isLoading && !isError && files.length > 0 && (
        <div className="code-panel__body">
          <aside className="code-panel__files">
            {files.map((f) => (
              <button
                key={f.path}
                type="button"
                className={`code-file-btn ${selectedPath === f.path ? 'active' : ''}`}
                onClick={() => setActivePath(f.path)}
                title={f.path}
              >
                {f.path}
              </button>
            ))}
          </aside>
          <div className="code-panel__content">
            <Editor
              key={selectedFile?.path || 'empty'}
              height="640px"
              theme="gherkin-dark"
              beforeMount={registerGherkin}
              language={selectedFile ? languageForPath(selectedFile.path) : 'plaintext'}
              value={selectedFile?.content || ''}
              options={{
                readOnly: true,
                domReadOnly: true,
                minimap: { enabled: false },
                fontSize: 12,
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                renderWhitespace: 'none',
                wordWrap: 'off',
                automaticLayout: true,
                tabSize: 2,
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
