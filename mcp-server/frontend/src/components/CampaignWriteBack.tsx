import { useState } from 'react';
import { Send, MessageSquare, ExternalLink, Loader2 } from 'lucide-react';
import { useExportToXrayMutation, useCommentOnJiraMutation } from '../store/services/campaignsApi';
import { useGetJiraConfigQuery, useGetXrayConfigQuery } from '../store/services/settingsApi';
import { Button } from './Button';
import type { Campaign, XrayExport, JiraComments } from '../types';

// A campaign's results written back: to Xray as a Test Execution (mcp-server/lib/xray.js), and
// to the Jira stories it checks as IziTest's comment on each (mcp-server/lib/jira.js). Each is
// previewed — what would be sent — before it can be sent.

const errorOf = (err: unknown) => (err as { data?: { error?: string } })?.data?.error ?? 'The request failed';

export function CampaignWriteBack({ campaign: c }: { campaign: Campaign }) {
  const { data: jira } = useGetJiraConfigQuery();
  const { data: xray } = useGetXrayConfigQuery();
  const [open, setOpen] = useState<'xray' | 'jira' | null>(null);
  if (c.running) return null;
  const stories = c.requirements.length > 0;

  return (
    <div className="dash-panel">
      <div className="dash-panel__title">Jira and Xray</div>
      {!jira && !xray && <p className="explore-help">Set a Jira site and an Xray API key in Settings to send these results there.</p>}
      {jira && !xray && <p className="explore-help">To send these results to Xray as a Test Execution: its API key, in Settings → Xray.</p>}
      {jira && !stories && <p className="explore-help">No requirement is checked by these tests: no Jira story to comment on.</p>}
      {c.xray_execution_key && (
        <p className="explore-help">
          Sent to Xray: {jira ? (
            <a className="campaign-link" href={`${jira.baseUrl}/browse/${c.xray_execution_key}`} target="_blank" rel="noreferrer">
              {c.xray_execution_key} <ExternalLink size={11} />
            </a>
          ) : <strong>{c.xray_execution_key}</strong>} — sent again, it is updated.
        </p>
      )}
      <div className="repair-actions">
        {xray && <Button size="sm" variant="action" icon={Send} onClick={() => setOpen(open === 'xray' ? null : 'xray')}>Send to Xray…</Button>}
        {jira && stories && (
          <Button size="sm" variant="action" icon={MessageSquare} onClick={() => setOpen(open === 'jira' ? null : 'jira')}>Comment on the Jira stories…</Button>
        )}
      </div>
      {open === 'xray' && <XrayPanel campaign={c} site={jira?.baseUrl ?? null} onClose={() => setOpen(null)} />}
      {open === 'jira' && <CommentsPanel campaign={c} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** The Test Execution the campaign would be, then is: its project and Test Plan, each test's status and stories. */
function XrayPanel({ campaign: c, site, onClose }: { campaign: Campaign; site: string | null; onClose: () => void }) {
  const [send, { isLoading }] = useExportToXrayMutation();
  const [project, setProject] = useState('');
  const [plan, setPlan] = useState('');
  const [preview, setPreview] = useState<XrayExport | null>(null);
  const [sent, setSent] = useState<XrayExport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = async (dryRun: boolean) => {
    setError(null);
    try {
      const result = await send({ id: c.id, project_key: project.trim() || undefined, test_plan_key: plan.trim() || undefined, dry_run: dryRun }).unwrap();
      if (dryRun) {
        setPreview(result);
        if (!project.trim()) setProject(result.project);
      } else setSent(result);
    } catch (err) {
      setError(errorOf(err));
      if (dryRun) setPreview(null);
    }
  };
  if (sent) {
    return (
      <div className="import-panel writeback-panel">
        <p className="import-done">
          Sent to Xray: {sent.url ? <a href={sent.url} target="_blank" rel="noreferrer">{sent.execution} <ExternalLink size={11} /></a> : sent.execution ?? 'a Test Execution'},
          in {sent.project} — {sent.tests.length} test{sent.tests.length === 1 ? '' : 's'}.
        </p>
        <div className="repair-actions"><Button size="sm" variant="action" onClick={onClose}>Close</Button></div>
      </div>
    );
  }
  return (
    <div className="import-panel writeback-panel">
      <p className="explore-help">
        Each test is a Generic test of Xray — created the first time, found again by its definition after —, linked to the stories it
        covers; passed is PASSED, failed is FAILED with the step and why, not run is TODO. Written to {site ?? 'Jira'} once sent.
      </p>
      <div className="writeback-fields">
        <label>Project <input type="text" value={project} placeholder="default: the stories'" onChange={(e) => setProject(e.target.value.toUpperCase())} spellCheck={false} /></label>
        <label>Test Plan <input type="text" value={plan} placeholder="optional, e.g. SHOP-40" onChange={(e) => setPlan(e.target.value.toUpperCase())} spellCheck={false} /></label>
        <Button size="sm" variant="action" disabled={isLoading} onClick={() => ask(true)}>{preview ? 'Preview again' : 'Preview'}</Button>
      </div>
      {isLoading && <p className="explore-help"><Loader2 size={12} className="spin" /> {preview ? 'Sending…' : 'Preparing…'}</p>}
      {error && <div className="repair-error">{error}</div>}
      {preview && (
        <>
          <p className="explore-help">
            Would {preview.updates ? <>update the Test Execution <strong>{preview.execution}</strong></> : 'create a Test Execution'} in <strong>{preview.project}</strong>:
          </p>
          <table className="campaign-table">
            <tbody>
              {preview.tests.map((t) => (
                <tr key={t.name}>
                  <td>{t.name}</td>
                  <td><span className={`xray-status xray-status--${t.status.toLowerCase()}`}>{t.status}</span></td>
                  <td className="dash-table__muted">{t.stories.length ? `covers ${t.stories.join(', ')}` : 'no story'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div className="repair-actions">
        <Button size="sm" variant="save" icon={Send} disabled={!preview || isLoading} onClick={() => ask(false)}>
          {preview?.updates ? `Update ${preview.execution}` : 'Send to Xray'}
        </Button>
        <Button size="sm" variant="cancel" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

/** IziTest's comment on each Jira story the campaign checks: what it would say, then posted. */
function CommentsPanel({ campaign: c, onClose }: { campaign: Campaign; onClose: () => void }) {
  const [post, { isLoading }] = useCommentOnJiraMutation();
  const [result, setResult] = useState<JiraComments | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = async (dryRun: boolean) => {
    setError(null);
    try {
      setResult(await post({ campaign_id: c.id, dry_run: dryRun }).unwrap());
    } catch (err) {
      setError(errorOf(err));
    }
  };

  return (
    <div className="import-panel writeback-panel">
      <p className="explore-help">
        One comment a story, IziTest's own: where it stands, each criterion with its tests and how they did. Posted again, it is updated.
      </p>
      {isLoading && <p className="explore-help"><Loader2 size={12} className="spin" /> {result ? 'Posting…' : 'Preparing…'}</p>}
      {error && <div className="repair-error">{error}</div>}
      {result?.warnings.length ? <ul className="import-warnings">{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
      {result && (
        <div className="bug-list">
          {result.comments.map((comment) => (
            <details key={comment.key} className="import-item" open={!result.sent}>
              <summary>
                <span className="requirement-key">{comment.key}</span>
                {comment.error ? <span className="repair-error">Not commented: {comment.error}</span>
                  : result.sent ? <a href={comment.url} target="_blank" rel="noreferrer">{comment.action} <ExternalLink size={11} /></a>
                    : <span className="dash-table__muted">{comment.action === 'update' ? 'updates IziTest\'s comment' : 'adds a comment'}</span>}
              </summary>
              <pre className="writeback-comment">{comment.text}</pre>
            </details>
          ))}
        </div>
      )}
      <div className="repair-actions">
        {!result && <Button size="sm" variant="action" disabled={isLoading} onClick={() => ask(true)}>Preview the comments</Button>}
        {result && !result.sent && (
          <Button size="sm" variant="save" icon={MessageSquare} disabled={!result.comments.length || isLoading} onClick={() => ask(false)}>
            Post {result.comments.length} comment{result.comments.length === 1 ? '' : 's'}
          </Button>
        )}
        <Button size="sm" variant={result?.sent ? 'action' : 'cancel'} onClick={onClose}>{result?.sent ? 'Close' : 'Cancel'}</Button>
      </div>
    </div>
  );
}
