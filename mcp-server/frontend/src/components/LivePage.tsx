import { useEffect, useState } from 'react';
import { MonitorPlay } from 'lucide-react';
import { Card, EmptyState, PageHeader } from './ui';
import { LiveScreen } from './LiveScreen';

// /watch — what the agents connected to IziTest are doing in their browser, live (not /live:
// that path is the server's stream, lib/live.js): each session's window
// (GET /live/sessions, mcp-server/lib/live.js) and the stream of the tab picked. Where an agent
// working in the browser without windows — no Chrome with the extension on this computer — is
// watched: nothing else shows it.

interface LiveTab { tabId: number; url: string; title: string; active: boolean; recording?: boolean; popup?: boolean }
interface LiveSession {
  id: string;
  name: string;
  client: { name?: string; version?: string } | null;
  tabs: LiveTab[];
  lastAction?: { tool: string; at: string; status: string } | null;
  createdAt?: string;
}

const POLL_MS = 2000;

const timeOf = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');

export function LivePage() {
  const [sessions, setSessions] = useState<LiveSession[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<number | null>(null);

  useEffect(() => {
    let stopped = false;
    const read = async () => {
      try {
        const res = await fetch('/live/sessions');
        if (!res.ok) throw new Error(`The server answered ${res.status}`);
        const body = await res.json() as { enabled: boolean; sessions: LiveSession[] };
        if (stopped) return;
        setEnabled(body.enabled);
        setSessions(body.sessions ?? []);
        setError(null);
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err.message : String(err));
      }
    };
    read();
    const timer = setInterval(read, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, []);

  const tabs = (sessions ?? []).flatMap((s) => s.tabs.map((t) => ({ ...t, session: s })));
  // The tab picked while it is there; else the active tab of the session that acted last.
  const lastActing = [...(sessions ?? [])].sort((a, b) => (b.lastAction?.at ?? b.createdAt ?? '').localeCompare(a.lastAction?.at ?? a.createdAt ?? ''))[0];
  const shown = tabs.find((t) => t.tabId === picked)
    ?? tabs.find((t) => t.session === lastActing && t.active)
    ?? tabs[0] ?? null;

  return (
    <>
      <PageHeader
        title="Live"
        subtitle="What the agents connected to IziTest do in their browser, as they do it — also in the browser without windows, where nothing else shows it."
      />
      {error && <div className="alert alert--error">{error}</div>}
      {!enabled && <div className="alert">The live view is turned off on this server.</div>}
      {sessions && tabs.length === 0 ? (
        <Card>
          <EmptyState icon={MonitorPlay} title="No agent at work">
            When an agent opens a page — recording a test, exploring an app —, its window shows here, live.
          </EmptyState>
        </Card>
      ) : (
        <div className="live-page">
          <Card flush className="live-page__list">
            {(sessions ?? []).filter((s) => s.tabs.length).map((s) => (
              <div key={s.id} className="live-session">
                <div className="live-session__head">
                  <strong>{s.client?.name ?? s.name}</strong>
                  {s.lastAction && <span className="muted"> · {s.lastAction.tool} at {timeOf(s.lastAction.at)}</span>}
                </div>
                {s.tabs.map((t) => (
                  <button key={t.tabId} type="button" className={`live-tab${shown?.tabId === t.tabId ? ' live-tab--on' : ''}`} onClick={() => setPicked(t.tabId)}>
                    <span className="live-tab__title">{t.title || t.url}</span>
                    <span className="live-tab__url">{t.url}</span>
                    {t.recording && <span className="tag tag--red">recording</span>}
                  </button>
                ))}
              </div>
            ))}
          </Card>
          <Card flush className="live-page__screen">
            <LiveScreen tabId={shown?.tabId ?? null} running={!!shown} waiting="Waiting for an agent to open a page…" />
          </Card>
        </div>
      )}
    </>
  );
}
