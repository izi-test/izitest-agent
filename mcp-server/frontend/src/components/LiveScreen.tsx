import { useEffect, useRef, useState } from 'react';
import { Loader2, MonitorOff } from 'lucide-react';

// What an agent or a test does in its browser tab, while it does it: the tab's stream of
// images (mcp-server/lib/live.js, GET /live/tabs/:id/stream), read frame by frame. Read with
// fetch rather than an <img>: a refusal says why (live view off, too many viewers), and the
// last image stays once the stream ends — the window closed, the run over.

const FPS = 8;
// A stream that ends while the run goes on (the tab reloaded its renderer) is opened again.
const RETRY_MS = 1500;

type State =
  | { kind: 'waiting' }
  | { kind: 'connecting' }
  | { kind: 'live' }
  | { kind: 'ended' }
  | { kind: 'unavailable'; reason: string };

export function LiveScreen({ tabId, running, waiting = 'Waiting for the browser to open a page…' }: {
  /** The tab to show; null until the run has opened one. */
  tabId: number | null;
  /** Whether the run is still going: a stream that ends then is opened again. */
  running: boolean;
  waiting?: string;
}) {
  const [frame, setFrame] = useState<string | null>(null);
  const [state, setState] = useState<State>({ kind: 'waiting' });
  const [attempt, setAttempt] = useState(0);
  const runningRef = useRef(running);
  runningRef.current = running;

  useEffect(() => {
    if (tabId == null) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    setState((s) => (s.kind === 'live' ? s : { kind: 'connecting' }));
    (async () => {
      try {
        const res = await fetch(`/live/tabs/${tabId}/stream?fps=${FPS}`, { signal: controller.signal });
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({} as { error?: string }));
          setState({ kind: 'unavailable', reason: reasonOf(res.status, data.error) });
          return;
        }
        for await (const jpeg of jpegFrames(res.body)) {
          setFrame(URL.createObjectURL(new Blob([jpeg as BlobPart], { type: 'image/jpeg' })));
          setState({ kind: 'live' });
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      if (controller.signal.aborted) return;
      setState({ kind: 'ended' });
      if (runningRef.current) retry = setTimeout(() => setAttempt((a) => a + 1), RETRY_MS);
    })();
    return () => { controller.abort(); clearTimeout(retry); };
  }, [tabId, attempt]);

  // The image shown before this one is no longer needed.
  useEffect(() => () => { if (frame) URL.revokeObjectURL(frame); }, [frame]);

  const badge = state.kind === 'live' && running ? 'Live'
    : state.kind === 'connecting' ? 'Connecting…'
      : frame && !running ? 'Last image' : null;

  return (
    <div className="live-screen">
      {frame && <img className="live-screen__frame" src={frame} alt="What the browser shows" />}
      {badge && <span className={`live-screen__badge ${badge === 'Live' ? 'live-screen__badge--live' : ''}`}>{badge}</span>}
      {!frame && (
        <div className="live-screen__message">
          {state.kind === 'unavailable' ? (
            <><MonitorOff size={22} /><span>{state.reason}</span></>
          ) : tabId == null ? (
            running ? <><Loader2 size={20} className="spin" /><span>{waiting}</span></> : <span>Nothing was shown in a browser.</span>
          ) : state.kind === 'ended' && !running ? (
            <span>The browser window was closed before an image came.</span>
          ) : (
            <><Loader2 size={20} className="spin" /><span>Connecting to the browser…</span></>
          )}
        </div>
      )}
    </div>
  );
}

function reasonOf(status: number, error?: string): string {
  if (status === 503) return 'Live view is switched off on the server.';
  if (status === 429) return 'This tab is already watched twice, the most it allows.';
  if (status === 404) return 'The browser window is closed.';
  return error ?? `The live view did not answer (HTTP ${status}).`;
}

const HEADER_END = [13, 10, 13, 10];

/** The JPEG images of a multipart stream whose parts say their Content-Length (lib/live.js). */
async function* jpegFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = new Uint8Array(0);
  try {
    while (true) {
      const end = indexOf(buffer, HEADER_END);
      if (end >= 0) {
        const length = Number(/Content-Length:\s*(\d+)/i.exec(decoder.decode(buffer.subarray(0, end)))?.[1]);
        if (!Number.isFinite(length)) return; // not a stream of images
        const start = end + HEADER_END.length;
        if (buffer.length >= start + length) {
          yield buffer.slice(start, start + length);
          buffer = buffer.slice(start + length);
          continue;
        }
      }
      const { done, value } = await reader.read();
      if (done) return;
      const joined = new Uint8Array(buffer.length + value.length);
      joined.set(buffer);
      joined.set(value, buffer.length);
      buffer = joined;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function indexOf(haystack: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
