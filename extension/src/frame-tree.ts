// Merging the snapshots of cross-origin iframes into the page's snapshot.
//
// Each cross-origin frame snapshots itself, in its own frame, numbering its refs after the
// ones already handed out. Its lines then go right under the "@eN [iframe]" line its parent
// gave that iframe, indented one level deeper — so the agent reads one tree, as if the
// frame's content were part of the page, which is what it sees on screen.
//
// Pure: no Chrome APIs, tested on its own.

export interface FrameAttachment {
  /** The frame whose snapshot contains the <iframe> line. */
  parentFrameId: number;
  /** The ref the parent gave that <iframe>, or null when it is not in the parent's tree. */
  ref: string | null;
  childFrameId: number;
  /** Where the frame comes from, shown when its <iframe> line cannot be found. */
  src: string;
}

const REF_AT_START = /^(@e\d+)\b/;

export function mergeFrameTrees(
  trees: Map<number, string[]>,
  attachments: FrameAttachment[],
  topFrameId = 0
): string[] {
  const byPlace = new Map<string, FrameAttachment[]>();
  for (const a of attachments) {
    if (a.ref === null) continue;
    const key = `${a.parentFrameId}|${a.ref}`;
    byPlace.set(key, [...(byPlace.get(key) ?? []), a]);
  }

  const out: string[] = [];
  const emitted = new Set<number>();

  const emit = (frameId: number, baseIndent: string) => {
    if (emitted.has(frameId)) return;
    emitted.add(frameId);
    for (const line of trees.get(frameId) ?? []) {
      if (!line) continue;
      out.push(baseIndent + line);
      const trimmed = line.trimStart();
      const ref = trimmed.match(REF_AT_START)?.[1];
      if (!ref) continue;
      const lineIndent = line.slice(0, line.length - trimmed.length);
      for (const child of byPlace.get(`${frameId}|${ref}`) ?? []) {
        emit(child.childFrameId, baseIndent + lineIndent + '  ');
      }
    }
  };

  emit(topFrameId, '');

  // Frames whose <iframe> line is not in the tree — filtered out by searchText, or sitting
  // inside a same-origin frame that was merged into its parent — still get shown, at the
  // end, under the address they were loaded from.
  for (const a of attachments) {
    if (emitted.has(a.childFrameId) || !trees.get(a.childFrameId)?.some(Boolean)) continue;
    out.push(`[cross-origin frame] "${a.src}"`);
    emit(a.childFrameId, '  ');
  }

  return out;
}
