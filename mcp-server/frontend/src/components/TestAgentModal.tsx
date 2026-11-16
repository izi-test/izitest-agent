import { useCallback, useEffect, useRef, useState } from 'react';
import { AppWindow, Bot, EyeOff, Loader2, RotateCcw, Send, Square, X } from 'lucide-react';
import { Button } from './Button';
import { LiveScreen } from './LiveScreen';
import { HeadlessSwitch } from './HeadlessSwitch';
import { AgentAskForm } from './AgentAsk';
import { ConfirmModal } from './ConfirmModal';
import { useRunWindow } from '../agent-asks';
import { useRunHeadless } from '../headless';
import type { AgentAsk } from '../types';

// A test's conversation with the agent (mcp-server/lib/agent/test-chat.js): its browser, live,
// on the left; what is asked and what it answers on the right. Ask it to repair the test, to
// change it, to say what it does. The conversation is the test's: opened again, it is there.

interface AgentMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  /** What the agent did for this answer, a line per action. */
  activity: string[];
  status: 'done' | 'stopped' | 'error' | null;
}

interface Conversation {
  agent: { available: boolean; reason?: string };
  messages: AgentMessage[];
  /** Its browser session is open since a message of this window; the tab it works in. */
  open: boolean;
  working: boolean;
  headless: boolean | null;
  tab_id: number | null;
}

interface TestAgentModalProps {
  testName: string;
  isOpen: boolean;
  onClose: () => void;
  /** After an answer: the test may have changed, runs were added. */
  onAnswered: (testChanged: boolean) => void;
  /** Its last run failed: repairing it is offered first. */
  lastRunFailed: boolean;
}

export function TestAgentModal({ testName, isOpen, onClose, onAnswered, lastRunFailed }: TestAgentModalProps) {
  const base = `/api/tests/${encodeURIComponent(testName)}/agent`;
  const headless = useRunHeadless();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  // The answer the agent is working on: what it did so far, what it said so far.
  const [answer, setAnswer] = useState<{ activity: string[]; text: string } | null>(null);
  const [liveTabId, setLiveTabId] = useState<number | null>(null);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [ask, setAsk] = useState<AgentAsk | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  // Asked first: closing while the agent works, forgetting the conversation.
  const [confirming, setConfirming] = useState<'close' | 'startOver' | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const working = answer !== null;

  const load = useCallback(async () => {
    try {
      const response = await fetch(base);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setConversation(data);
      setMessages(data.messages);
      setSessionOpen(data.open);
      if (data.tab_id != null) setLiveTabId(data.tab_id);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [base]);

  useEffect(() => {
    if (!isOpen) return;
    setConversation(null);
    setMessages([]);
    setAnswer(null);
    setLiveTabId(null);
    setSessionOpen(false);
    setAsk(null);
    setInput('');
    setError(null);
    setStopping(false);
    setConfirming(null);
    load();
  }, [isOpen, load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, answer?.activity.length, answer?.text, ask]);

  useEffect(() => {
    if (isOpen && !working) inputRef.current?.focus();
  }, [isOpen, working, conversation]);

  // The page left with the window open: the agent's browser window is given back.
  useEffect(() => {
    if (!isOpen) return undefined;
    return () => {
      abortRef.current?.abort();
      fetch(`${base}/close`, { method: 'POST', keepalive: true }).catch(() => {});
    };
  }, [isOpen, base]);

  // While its agent works, the dock of this page leaves other runs' questions to their windows.
  useRunWindow(isOpen && working);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || working) return;
    setInput('');
    setError(null);
    setAnswer({ activity: [], text: '' });
    setSessionOpen(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let answered = false;
    try {
      const response = await fetch(`${base}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, headless }), signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({} as { error?: string }));
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let event;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }
          if (event.type === 'user') {
            setMessages((list) => [...list, event.message]);
          } else if (event.type === 'live') {
            setLiveTabId(event.tabId);
          } else if (event.type === 'activity') {
            // What it said before acting joins what it did: its answer is what it says last.
            setAnswer((a) => a && { activity: [...a.activity, event.line], text: event.said ? '' : a.text });
          } else if (event.type === 'text') {
            setAnswer((a) => a && { ...a, text: a.text ? `${a.text}\n\n${event.text}` : event.text });
          } else if (event.type === 'ask') {
            setAsk(event.ask);
          } else if (event.type === 'ask_done') {
            setAsk((current) => (current?.id === event.id ? null : current));
          } else if (event.type === 'done') {
            answered = true;
            if (event.message) setMessages((list) => [...list, event.message]);
            else if (event.error) setError(event.error);
            onAnswered(event.changed !== false);
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      abortRef.current = null;
      setAnswer(null);
      setAsk(null);
      setStopping(false);
      // The stream ended without its answer (the server went away): what was kept is shown.
      if (!answered && !controller.signal.aborted) load();
    }
  };

  const stop = async () => {
    setStopping(true);
    try {
      await fetch(`${base}/stop`, { method: 'POST' });
    } catch {
      abortRef.current?.abort();
    }
  };

  const close = () => {
    if (working) setConfirming('close');
    else onClose();
  };

  const startOver = async () => {
    setConfirming(null);
    try {
      const response = await fetch(base, { method: 'DELETE' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setMessages([]);
      setLiveTabId(null);
      setSessionOpen(false);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!isOpen) return null;

  const unavailable = conversation && !conversation.agent.available ? conversation.agent.reason : null;
  const inHeadless = sessionOpen && conversation?.headless != null ? conversation.headless : headless;
  const suggestions: Array<{ label: string; text: string; fill?: boolean }> = [
    ...(lastRunFailed ? [{ label: 'Repair it: its last run failed', text: 'The last run of this test failed. Find why and repair the test, then run it again to confirm.' }] : []),
    { label: 'Run it and tell me what it checks', text: 'Run this test and tell me, step by step, what it does and what it checks.' },
    { label: 'Add a check…', text: 'Add a check that ', fill: true },
    { label: 'Change a step…', text: 'Change the step that ', fill: true },
  ];

  return (
    // Closed by its buttons only: a click beside it would stop the agent at work.
    <div className="modal">
      <div className="modal-overlay" />
      <div className="modal-content test-agent" role="dialog" aria-label={`Agent of the test ${testName}`}>
        <div className="modal-header">
          <h3><Bot size={18} style={{ verticalAlign: '-3px', marginRight: 8 }} />Ask the agent · <span className="test-agent__name">{testName}</span></h3>
          <div className="test-agent__header-actions">
            {messages.length > 0 && !working && (
              <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => setConfirming('startOver')} title="Forget this conversation: the agent starts from the test as it is">Start over</Button>
            )}
            <button className="btn-close" onClick={close} aria-label="Close"><X size={18} /></button>
          </div>
        </div>

        <div className="test-agent__body">
          <div className="test-agent__screen">
            <LiveScreen tabId={liveTabId} running={working} waiting="Waiting for the agent to open a page…"
              idle="The browser the agent works in shows here, live, as soon as it opens a page." />
            <div className="test-agent__where">
              {sessionOpen ? (
                // Chosen when its browser session opened: said, not offered again.
                <p className="test-agent__where-line">
                  {inHeadless ? <EyeOff size={14} /> : <AppWindow size={14} />}
                  {inHeadless
                    ? 'The agent works in the Chrome without windows: you follow it here only.'
                    : 'The agent works in a window of your Chrome, opened without taking the focus.'}
                  <span>Close this window to change it.</span>
                </p>
              ) : (
                <HeadlessSwitch />
              )}
            </div>
          </div>

          <div className="test-agent__chat">
            <div className="chat-messages test-agent__messages">
              {conversation && messages.length === 0 && !working && !unavailable && (
                <div className="chat-welcome">
                  <Bot size={36} strokeWidth={1.2} />
                  <h3>What should the agent do with this test?</h3>
                  <p>It runs the test in the browser on the left, repairs the steps that fail, and changes the test as you ask — then tells you what it did.</p>
                  <div className="chat-suggestions">
                    {suggestions.map((s) => (
                      <button key={s.label} className="chat-suggestion" onClick={() => {
                        if (s.fill) { setInput(s.text); inputRef.current?.focus(); } else send(s.text);
                      }}>{s.label}</button>
                    ))}
                  </div>
                </div>
              )}
              {unavailable && <div className="create-wf-error">{unavailable}</div>}

              {messages.map((message) => (
                <div key={message.id} className={`chat-message chat-message-${message.role}`}>
                  <div className="chat-message-avatar">{message.role === 'user' ? 'You' : <Bot size={15} />}</div>
                  <div className="chat-message-content">
                    {message.role === 'assistant' && message.activity.length > 0 && (
                      <details className="test-agent__did">
                        <summary>{message.activity.length} action{message.activity.length === 1 ? '' : 's'}</summary>
                        <ol>{message.activity.map((line, i) => <li key={i}>{line}</li>)}</ol>
                      </details>
                    )}
                    <AgentText content={message.content} />
                    {message.status === 'stopped' && <span className="test-agent__status">Stopped{message.content ? '' : ' before it answered'}</span>}
                    {message.status === 'error' && <span className="test-agent__status test-agent__status--error">It did not finish</span>}
                  </div>
                </div>
              ))}

              {answer && (
                <div className="chat-message chat-message-assistant">
                  <div className="chat-message-avatar"><Bot size={15} /></div>
                  <div className="chat-message-content">
                    {answer.activity.length > 0 && (
                      <ol className="test-agent__doing" start={Math.max(1, answer.activity.length - 4)}>
                        {answer.activity.slice(-5).map((line, i, shown) => (
                          <li key={answer.activity.length - shown.length + i} className={i === shown.length - 1 ? 'current' : ''}>{line}</li>
                        ))}
                      </ol>
                    )}
                    <AgentText content={answer.text} />
                    <span className="chat-thinking"><Loader2 size={14} className="chat-spinner" />{stopping ? 'Stopping…' : 'Working…'}</span>
                  </div>
                </div>
              )}
              {ask && working && <AgentAskForm ask={ask} onSettled={() => setAsk(null)} />}
              {error && <div className="create-wf-error">{error}</div>}
              <div ref={endRef} />
            </div>

            <div className="chat-input-area">
              <textarea
                ref={inputRef}
                className="chat-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); }
                }}
                placeholder={working ? 'The agent is working…' : 'Repair it, add a check, change a step…'}
                rows={2}
                disabled={working || !conversation || !!unavailable}
                aria-label="Message to the agent"
              />
              {working ? (
                <button className="chat-send-btn test-agent__stop" onClick={stop} disabled={stopping} title="Stop the agent" aria-label="Stop the agent"><Square size={16} /></button>
              ) : (
                <button className="chat-send-btn" onClick={() => send(input)} disabled={!input.trim() || !conversation || !!unavailable} title="Send" aria-label="Send"><Send size={18} /></button>
              )}
            </div>
            <p className="test-agent__note">Never type a password here: the agent asks for it in a form, and it is kept in the project's secrets.</p>
          </div>
        </div>
      </div>

      <ConfirmModal
        isOpen={confirming === 'startOver'}
        tone="primary"
        title="Start the conversation over?"
        message="What was said here is forgotten, and the agent starts from the test as it is now. The test itself does not change."
        confirmLabel="Start over"
        onConfirm={startOver}
        onCancel={() => setConfirming(null)}
      />
      <ConfirmModal
        isOpen={confirming === 'close' && working}
        tone="primary"
        title="Close while the agent works?"
        message="Closing stops the agent. What it already changed in the test stays; the conversation is kept."
        confirmLabel="Stop it and close"
        onConfirm={onClose}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}

/** Bold and code inside a line, as React nodes: what the agent wrote is never read as HTML. */
function inline(text: string) {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i} className="chat-inline-code">{part.slice(1, -1)}</code>;
    return part;
  });
}

/** An agent's text: paragraphs, lists, code blocks, bold and inline code. */
function AgentText({ content }: { content: string }) {
  if (!content) return null;
  const blocks: React.ReactNode[] = [];
  content.split(/(```[\s\S]*?```)/g).forEach((part, p) => {
    if (part.startsWith('```')) {
      const lines = part.slice(3, part.endsWith('```') ? -3 : undefined).split('\n');
      blocks.push(<pre key={p} className="chat-code-block"><code>{lines.slice(1).join('\n').trim() || lines[0]}</code></pre>);
      return;
    }
    // The list being read, if a line before started one.
    const open: { list: { ordered: boolean; items: string[] } | null } = { list: null };
    const flush = (key: string) => {
      const { list } = open;
      if (!list) return;
      const items = list.items.map((item, i) => <li key={i}>{inline(item)}</li>);
      blocks.push(list.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
      open.list = null;
    };
    part.split('\n').forEach((raw, l) => {
      const line = raw.trim();
      const bullet = /^[-*•]\s+(.*)$/.exec(line);
      const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
      const item = bullet ?? numbered;
      if (item) {
        const ordered = !bullet;
        if (open.list && open.list.ordered !== ordered) flush(`${p}-${l}-l`);
        open.list ??= { ordered, items: [] };
        open.list.items.push(item[1]);
        return;
      }
      flush(`${p}-${l}-l`);
      if (!line) return;
      const heading = /^#{1,4}\s+(.*)$/.exec(line);
      blocks.push(heading ? <p key={`${p}-${l}`}><strong>{inline(heading[1])}</strong></p> : <p key={`${p}-${l}`}>{inline(line)}</p>);
    });
    flush(`${p}-end`);
  });
  return <div className="test-agent__text">{blocks}</div>;
}
