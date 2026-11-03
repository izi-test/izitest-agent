import { useState } from 'react';
import { Check, Combine, Loader2, Sparkles, X } from 'lucide-react';
import {
  useAcceptBusinessStepMutation, useDismissBusinessStepMutation, useGetBusinessProposalsQuery, useProposeBusinessStepsMutation,
} from '../store/services/testsApi';
import { useAppDispatch } from '../store/hooks';
import { showToast } from '../store/slices/uiSlice';
import { setActiveTab } from '../store/slices/testDetailSlice';
import { useGo } from '../navigation';
import { Button } from './Button';
import { Card, KeyChip, Pill } from './ui';
import type { BusinessProposal } from '../types';

// The business steps the AI agent proposes for a test (mcp-server/lib/business-steps.js): runs of
// its steps that together do one thing a user means, each as one phrase of the project. Asked
// after a test is created by the AI, or here; each one accepted as the user words it, or
// dismissed. Accepted, every test acting on the same elements reads with it.

const errorOf = (err: unknown) => (err as { data?: { error?: string } })?.data?.error ?? 'The request failed';

/** The proposals of a test, followed while the agent works them out. */
function useProposals(testName: string) {
  const { data } = useGetBusinessProposalsQuery(testName);
  // Asked every 3 s while it runs.
  useGetBusinessProposalsQuery(testName, { pollingInterval: data?.status === 'running' ? 3000 : 0 });
  return data;
}

export function BusinessStepProposals({ testName }: { testName: string }) {
  const record = useProposals(testName);
  const [propose, { isLoading: asking, error: askError }] = useProposeBusinessStepsMutation();
  const [dismiss] = useDismissBusinessStepMutation();
  const running = record?.status === 'running' || asking;
  const proposals = record?.status === 'ready' ? record.proposals : [];

  return (
    <Card
      title="Business steps" icon={Combine} className="business-proposals"
      subtitle="Runs of steps that together do one thing a user means, as one phrase of the project. The AI agent proposes them; you accept or dismiss each."
      actions={(
        <Button size="sm" variant="secondary" icon={running ? Loader2 : Sparkles} disabled={running} onClick={() => propose(testName)}>
          {running ? 'Proposing…' : record?.status === 'ready' || record?.status === 'failed' ? 'Propose again' : 'Propose business steps'}
        </Button>
      )}
    >
      {running ? (
        <p className="explore-help"><Loader2 size={12} className="spin" /> The agent is reading the test. It takes up to a few minutes.</p>
      ) : record?.status === 'failed' || askError ? (
        <div className="alert alert--error">{record?.error ?? errorOf(askError)}</div>
      ) : record?.status === 'ready' && proposals.length === 0 ? (
        <p className="muted">The agent found nothing worth grouping in this test.</p>
      ) : record?.status !== 'ready' ? (
        <p className="muted">Steps a business step of the project already groups read as it in the Gherkin below. Ask the agent for the others.</p>
      ) : (
        <>
          <div className="business-proposals__list">
            {proposals.map((proposal) => <ProposalRow key={proposal.id} testName={testName} proposal={proposal} />)}
          </div>
          {proposals.length > 1 && (
            <div className="business-proposals__footer">
              <Button size="sm" variant="ghost" icon={X} onClick={() => dismiss({ testName })}>Dismiss all</Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function ProposalRow({ testName, proposal }: { testName: string; proposal: BusinessProposal }) {
  const dispatch = useAppDispatch();
  const go = useGo();
  const [pattern, setPattern] = useState(proposal.pattern);
  const [accept, { isLoading: accepting, error }] = useAcceptBusinessStepMutation();
  const [dismiss, { isLoading: dismissing }] = useDismissBusinessStepMutation();
  const steps = proposal.from_step === proposal.to_step ? `Step ${proposal.from_step}` : `Steps ${proposal.from_step}–${proposal.to_step}`;

  const onAccept = async () => {
    const done = await accept({ testName, id: proposal.id, pattern }).unwrap().catch(() => null);
    if (done) dispatch(showToast({ message: 'Business step created', type: 'success' }));
  };

  return (
    <div className="business-proposal">
      <div className="business-proposal__head">
        <Pill tone="blue">{steps}</Pill>
        <span className="business-proposal__keyword">{proposal.keyword}</span>
        <input
          className="business-proposal__pattern" value={pattern} aria-label={`Phrase of ${steps.toLowerCase()}`}
          onChange={(e) => setPattern(e.target.value)} disabled={accepting}
        />
      </div>
      <div className="business-proposal__body">
        <div className="business-proposal__reads mono">{pattern === proposal.pattern ? proposal.reads : `${proposal.keyword} ${pattern}`}</div>
        <div className="business-proposal__replaces">
          <span className="muted">Instead of</span>
          {proposal.replaces.map((line, i) => <div key={i} className="mono">{line}</div>)}
        </div>
        {proposal.reason && <p className="muted">{proposal.reason}</p>}
        {proposal.also_in.length > 0 && (
          <div className="cell-chips">
            <span className="muted">Also reads in</span>
            {proposal.also_in.map((other) => (
              <KeyChip key={other} onClick={() => go(`/tests/${encodeURIComponent(other)}`, { from: testName })}>{other}</KeyChip>
            ))}
          </div>
        )}
        {error && <div className="field__error">{errorOf(error)}</div>}
      </div>
      <div className="business-proposal__actions">
        <Button size="sm" icon={accepting ? Loader2 : Check} disabled={accepting || dismissing || !pattern.trim()} onClick={onAccept}>Accept</Button>
        <Button size="sm" variant="ghost" icon={X} disabled={accepting || dismissing} onClick={() => dismiss({ testName, id: proposal.id })}>Dismiss</Button>
      </div>
    </div>
  );
}

/** In the Steps tab: the agent is proposing business steps, or has, for the Gherkin tab. */
export function BusinessStepsNotice({ testName }: { testName: string }) {
  const dispatch = useAppDispatch();
  const record = useProposals(testName);
  const count = record?.status === 'ready' ? record.proposals.length : 0;
  if (record?.status !== 'running' && count === 0) return null;
  return (
    <div className="business-notice">
      {record?.status === 'running'
        ? <><Loader2 size={14} className="spin" /> The AI agent is proposing business steps for this test.</>
        : <><Sparkles size={14} /> {count} business step{count === 1 ? '' : 's'} proposed by the AI agent.</>}
      <button className="link-btn" onClick={() => dispatch(setActiveTab('gherkin'))}>Review in Gherkin</button>
    </div>
  );
}
