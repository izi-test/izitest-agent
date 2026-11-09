import { useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, GripVertical, Plus, Trash2 } from 'lucide-react';
import { Segmented } from './ui';
import type { CampaignStage } from '../types';

// The stages of a campaign (mcp-server/lib/campaigns.js): run one after the other, each its
// tests side by side or one after the other, and, if asked, only when the stages before it
// passed. A test is dragged from a stage to another, or moved with its arrows (the keyboard).

type Mode = CampaignStage['mode'];

/** The stages, edited in place: what they are, and what replaces them. */
export function StageEditor({ stages, onChange }: { stages: CampaignStage[]; onChange: (stages: CampaignStage[]) => void }) {
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);

  const edit = (index: number, patch: Partial<CampaignStage>) => onChange(stages.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  /** `name` moved to stage `to`, before `before` (at its end without), a stage added past the last. */
  const move = (name: string, to: number, before?: string) => {
    const next: CampaignStage[] = stages.map((s) => ({ ...s, tests: s.tests.filter((t) => t !== name) }));
    if (to >= next.length) next.push({ mode: 'parallel', tests: [], needs_previous: false });
    const target = next[to];
    const at = before ? target.tests.indexOf(before) : -1;
    target.tests = at >= 0 ? [...target.tests.slice(0, at), name, ...target.tests.slice(at)] : [...target.tests, name];
    onChange(withoutEmpty(next));
  };
  const reorder = (index: number, name: string, by: number) => {
    const tests = [...stages[index].tests];
    const at = tests.indexOf(name);
    const to = at + by;
    if (to < 0 || to >= tests.length) return;
    [tests[at], tests[to]] = [tests[to], tests[at]];
    edit(index, { tests });
  };
  const remove = (index: number) => {
    // Its tests go to the stage before it (after it for the first).
    const into = index > 0 ? index - 1 : 1;
    const next = stages.map((s, i) => (i === into ? { ...s, tests: [...s.tests, ...stages[index].tests] } : s));
    onChange(withoutEmpty(next.filter((_, i) => i !== index)));
  };

  const drop = (to: number, before?: string) => (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const name = dragged ?? event.dataTransfer.getData('text/plain');
    setDragged(null);
    setOver(null);
    if (name) move(name, to, before);
  };

  return (
    <div className="stage-editor">
      {stages.map((stage, index) => (
        <section
          key={index} className={`stage-card ${over === index ? 'stage-card--over' : ''}`} aria-label={`Stage ${index + 1}`}
          onDragOver={(e) => { e.preventDefault(); setOver(index); }} onDragLeave={() => setOver(null)} onDrop={drop(index)}
        >
          <div className="stage-card__head">
            <span className="stage-card__number">{index + 1}</span>
            <input
              className="stage-card__name" value={stage.name ?? ''} placeholder={`Stage ${index + 1}`} aria-label={`Name of stage ${index + 1}`}
              onChange={(e) => edit(index, { name: e.target.value || undefined })}
            />
            <Segmented<Mode>
              label={`How the tests of stage ${index + 1} run`} value={stage.mode} onChange={(mode) => edit(index, { mode })}
              options={[{ value: 'parallel', label: 'Side by side' }, { value: 'sequential', label: 'One after the other' }]}
            />
            {stages.length > 1 && (
              <button type="button" className="icon-btn" title={`Remove stage ${index + 1}: its tests join the stage ${index > 0 ? 'before' : 'after'}`} onClick={() => remove(index)}>
                <Trash2 size={14} />
              </button>
            )}
          </div>
          {index > 0 && (
            <label className="stage-card__needs">
              <input type="checkbox" checked={stage.needs_previous} onChange={(e) => edit(index, { needs_previous: e.target.checked })} />
              <span>Only if every test of the stages before passed <span className="field__optional">otherwise its tests are skipped</span></span>
            </label>
          )}
          <ul className="stage-card__tests">
            {stage.tests.map((name, at) => (
              <li
                key={name} className={`stage-test ${dragged === name ? 'stage-test--dragged' : ''}`} draggable
                onDragStart={(e) => { setDragged(name); e.dataTransfer.setData('text/plain', name); e.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => { setDragged(null); setOver(null); }}
                onDragOver={(e) => { e.preventDefault(); setOver(index); }} onDrop={drop(index, name)}
              >
                <GripVertical size={12} className="stage-test__grip" aria-hidden />
                {stage.mode === 'sequential' && <span className="stage-test__order">{at + 1}.</span>}
                <span className="mono stage-test__name">{name}</span>
                <span className="stage-test__moves">
                  {stage.mode === 'sequential' && <>
                    <button type="button" className="icon-btn" title={`${name} earlier`} disabled={at === 0} onClick={() => reorder(index, name, -1)}><ArrowUp size={12} /></button>
                    <button type="button" className="icon-btn" title={`${name} later`} disabled={at === stage.tests.length - 1} onClick={() => reorder(index, name, 1)}><ArrowDown size={12} /></button>
                  </>}
                  <button type="button" className="icon-btn" title={`${name} to stage ${index}`} disabled={index === 0} onClick={() => move(name, index - 1)}><ChevronLeft size={12} /></button>
                  <button type="button" className="icon-btn" title={index === stages.length - 1 ? `${name} to a new stage` : `${name} to stage ${index + 2}`} onClick={() => move(name, index + 1)}><ChevronRight size={12} /></button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <div
        className={`stage-editor__new ${over === stages.length ? 'stage-card--over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(stages.length); }} onDragLeave={() => setOver(null)} onDrop={drop(stages.length)}
      >
        <Plus size={14} /> Drop a test here for a new stage, or move it with its arrow
      </div>
    </div>
  );
}

/** The stages left with a test; the first never waits for one before it. */
function withoutEmpty(stages: CampaignStage[]): CampaignStage[] {
  return stages.filter((s) => s.tests.length).map((s, i) => (i === 0 ? { ...s, needs_previous: false } : s));
}
