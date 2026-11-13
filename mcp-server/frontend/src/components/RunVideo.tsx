import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, X, SkipBack } from 'lucide-react';

/**
 * The video of a run (mcp-server/lib/run-video.js): the images of its tab as the screen changed,
 * played at their own pace — faster or slower —, the run's steps beside it. The step on screen
 * is lit; a click on a step goes to its start. A run too fast to follow live is watched again.
 */

interface VideoFrame { n: number; at: number }
interface VideoStep { step_order: number; command: string; intent: string | null; status: string; started_at: string | null; finished_at: string | null }
interface VideoData { video: { startedAt: number; frames: VideoFrame[] }; steps: VideoStep[] }

const SPEEDS = [0.25, 0.5, 1, 2];
// A pause longer than this (a page loading, a wait) is shortened when played.
const MAX_GAP_MS = 2000;

const clock = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};
const time = (iso: string | null) => (iso ? Date.parse(iso) : NaN);

export function RunVideo({ executionId, onClose }: { executionId: number; onClose: () => void }) {
  const [data, setData] = useState<VideoData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0.5);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    fetch(`/api/executions/${executionId}/video`, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Error ${res.status}`);
        return res.json() as Promise<VideoData>;
      })
      .then((answer) => { setData(answer); setPlaying(true); })
      .catch((err: Error) => setError(err.message));
  }, [executionId]);

  const frames = data?.video.frames ?? [];
  const src = (n: number) => `/api/executions/${executionId}/video/${n}`;

  // The next images, loaded before they are shown.
  useEffect(() => {
    for (const frame of frames.slice(index + 1, index + 6)) new Image().src = src(frame.n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, frames]);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!playing || !frames.length) return;
    if (index >= frames.length - 1) { setPlaying(false); return; }
    const gap = Math.min(MAX_GAP_MS, frames[index + 1].at - frames[index].at);
    timer.current = setTimeout(() => setIndex((i) => i + 1), Math.max(30, gap / speed));
    return () => clearTimeout(timer.current);
  }, [playing, index, speed, frames]);

  const steps = data?.steps ?? [];
  const now = frames[index]?.at ?? 0;
  // The step on screen: the last one started by then.
  const current = useMemo(() => {
    let found: number | null = null;
    for (const step of steps) if (time(step.started_at) <= now) found = step.step_order;
    return found;
  }, [steps, now]);

  const goToStep = (step: VideoStep) => {
    const start = time(step.started_at);
    if (Number.isNaN(start)) return;
    const at = frames.findIndex((frame) => frame.at >= start);
    setIndex(at < 0 ? frames.length - 1 : at);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p); }
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(frames.length - 1, i + 1));
      if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [frames.length, onClose]);

  const start = frames[0]?.at ?? 0;
  const total = (frames.at(-1)?.at ?? 0) - start;

  return (
    <div className="run-video__backdrop" onClick={onClose}>
      <div className="run-video" role="dialog" aria-label={`Video of run #${executionId}`} onClick={(e) => e.stopPropagation()}>
        <div className="run-video__head">
          <strong>Video of run #{executionId}</strong>
          <button className="icon-button" aria-label="Close" title="Close (Esc)" onClick={onClose}><X size={16} /></button>
        </div>
        {error && <div className="alert alert--error">{error}</div>}
        {!error && !data && <p className="explore-help">Loading the video…</p>}
        {data && frames.length > 0 && (
          <div className="run-video__body">
            <div className="run-video__screen">
              <img src={src(frames[index].n)} alt={`Image ${index + 1} of ${frames.length}`} />
              <div className="run-video__controls">
                <button className="icon-button" aria-label="Back to the start" title="Back to the start" onClick={() => { setIndex(0); setPlaying(false); }}><SkipBack size={15} /></button>
                <button className="icon-button" aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (space)' : 'Play (space)'}
                  onClick={() => { if (index >= frames.length - 1) setIndex(0); setPlaying((p) => !p); }}>
                  {playing ? <Pause size={15} /> : <Play size={15} />}
                </button>
                <input type="range" min={0} max={frames.length - 1} value={index} aria-label="Position in the video"
                  onChange={(e) => { setIndex(Number(e.target.value)); setPlaying(false); }} />
                <span className="run-video__time">{clock(now - start)} / {clock(total)}</span>
                <select value={speed} aria-label="Speed" onChange={(e) => setSpeed(Number(e.target.value))}>
                  {SPEEDS.map((s) => <option key={s} value={s}>×{s}</option>)}
                </select>
              </div>
            </div>
            <ol className="run-video__steps">
              {steps.map((step) => (
                <li key={step.step_order}>
                  <button type="button" className={`run-video__step ${current === step.step_order ? 'run-video__step--now' : ''} run-video__step--${step.status}`}
                    disabled={!step.started_at} title={step.started_at ? 'Go to this step' : 'Not played'} onClick={() => goToStep(step)}>
                    <span className="run-video__order">{step.step_order}</span>
                    <span className="run-video__what"><b>{step.command}</b> {step.intent}</span>
                    <span className="run-video__status">{step.status}</span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
