import { useMemo } from 'react';
import type { EditorState } from 'prosemirror-state';
import type { Mark } from 'prosemirror-model';
import type { TrackedChangeEntry } from '../components/sidebar/cardUtils';

type AtomicTrackedChangeType = 'insertion' | 'deletion';

interface AtomicTrackedChange {
  type: AtomicTrackedChangeType;
  text: string;
  author: string;
  date?: string;
  from: number;
  to: number;
  /** First revision id in document order for this contiguous segment. */
  revisionId: number;
  /** All raw OOXML revision ids represented by this contiguous segment. */
  revisionIds: number[];
}

const EMPTY_RESULT: TrackedChangesResult = {
  entries: [],
  commentToRevision: new Map<number, number>(),
  revisionIdToPrimary: new Map<number, number>(),
};

export interface TrackedChangesResult {
  /** Tracked-change entries, sorted by document position, with adjacent runs grouped. */
  entries: TrackedChangeEntry[];
  /**
   * Map of `commentId -> primaryRevisionId` for comments whose range overlaps a
   * tracked-change mark. For grouped replacements, comments anchored to any raw
   * deletion/insertion fragment resolve to the replacement card's primary id.
   */
  commentToRevision: Map<number, number>;
  /**
   * Maps every raw tracked-change revision id in the PM doc to its owning
   * sidebar entry's primary revision id. Identity for non-grouped changes.
   */
  revisionIdToPrimary: Map<number, number>;
}

function normalizeDate(date: string | undefined): string | null {
  return date ?? null;
}

function dedupeRevisionIds(ids: number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function hasSameAuthorAndDate(a: AtomicTrackedChange, b: AtomicTrackedChange): boolean {
  return a.author === b.author && normalizeDate(a.date) === normalizeDate(b.date);
}

function canMergeSegments(a: AtomicTrackedChange, b: AtomicTrackedChange): boolean {
  return a.type === b.type && a.to === b.from && hasSameAuthorAndDate(a, b);
}

function canFormReplacement(a: AtomicTrackedChange, b: AtomicTrackedChange): boolean {
  return a.type !== b.type && a.to === b.from && hasSameAuthorAndDate(a, b);
}

function mergeAdjacentSegments(entries: AtomicTrackedChange[]): AtomicTrackedChange[] {
  const merged: AtomicTrackedChange[] = [];
  for (const entry of entries) {
    const last = merged[merged.length - 1];
    if (last && canMergeSegments(last, entry)) {
      last.text += entry.text;
      last.to = entry.to;
      last.revisionIds = dedupeRevisionIds([...last.revisionIds, ...entry.revisionIds]);
    } else {
      merged.push({
        ...entry,
        revisionIds: dedupeRevisionIds(entry.revisionIds),
      });
    }
  }
  return merged;
}

function buildSingleEntry(segment: AtomicTrackedChange): TrackedChangeEntry {
  const revisionIds = dedupeRevisionIds(segment.revisionIds);
  const primaryRevisionId = revisionIds[0] ?? segment.revisionId;
  return {
    type: segment.type,
    text: segment.text,
    author: segment.author,
    date: segment.date,
    from: segment.from,
    to: segment.to,
    revisionId: primaryRevisionId,
    revisionIds,
    ...(segment.type === 'insertion'
      ? {
          insertionRevisionId: revisionIds[0] ?? primaryRevisionId,
          insertionRevisionIds: revisionIds,
        }
      : {
          deletionRevisionIds: revisionIds,
        }),
  };
}

function buildReplacementEntry(
  first: AtomicTrackedChange,
  second: AtomicTrackedChange
): TrackedChangeEntry {
  const deletion = first.type === 'deletion' ? first : second;
  const insertion = first.type === 'insertion' ? first : second;
  const deletionRevisionIds = dedupeRevisionIds(deletion.revisionIds);
  const insertionRevisionIds = dedupeRevisionIds(insertion.revisionIds);
  const allRevisionIds = dedupeRevisionIds([...first.revisionIds, ...second.revisionIds]);
  // Use the first segment's first revision id as the primary id so anchor
  // positions line up with the first visible fragment regardless of whether the
  // document serialized deletion→insertion or insertion→deletion.
  const primaryRevisionId = first.revisionIds[0] ?? first.revisionId;

  return {
    type: 'replacement',
    text: insertion.text,
    deletedText: deletion.text,
    author: first.author,
    date: first.date,
    from: Math.min(first.from, second.from),
    to: Math.max(first.to, second.to),
    revisionId: primaryRevisionId,
    revisionIds: allRevisionIds,
    deletionRevisionIds,
    insertionRevisionIds,
    insertionRevisionId: insertionRevisionIds[0],
  };
}

/**
 * Walk the PM doc once and derive (a) the tracked-change list, (b) a
 * comment→revision overlap map for threading, and (c) a raw-revision→primary
 * alias map for grouped replacements.
 *
 * Adjacent same-type fragments with the same author/date are first collapsed so
 * LibreOffice-style multi-run deletions like `[` + `CompanyName` + `]` become a
 * single deletion cluster. We then detect replacement clusters in either order:
 * deletion→insertion (preferred) or insertion→deletion (robustness for other
 * producers / older helper behavior).
 */
export function extractTrackedChanges(state: EditorState | null): TrackedChangesResult {
  if (!state) return EMPTY_RESULT;
  const { doc, schema } = state;
  const insertionType = schema.marks.insertion;
  const deletionType = schema.marks.deletion;
  const commentType = schema.marks.comment;
  if (!insertionType && !deletionType) return EMPTY_RESULT;

  const raw: AtomicTrackedChange[] = [];
  const commentToRawRevision = new Map<number, number>();
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    let tcMark: Mark | null = null;
    for (const mark of node.marks) {
      if (mark.type === insertionType || mark.type === deletionType) {
        const parsedRevisionId = Number(mark.attrs.revisionId);
        const revisionId = Number.isFinite(parsedRevisionId) ? parsedRevisionId : 0;
        raw.push({
          type: mark.type === insertionType ? 'insertion' : 'deletion',
          text: node.text || '',
          author: (mark.attrs.author as string) || '',
          date: (mark.attrs.date as string | null) ?? undefined,
          from: pos,
          to: pos + node.nodeSize,
          revisionId,
          revisionIds: [revisionId],
        });
        tcMark = mark;
      }
    }
    // Same-walk comment-to-revision overlap detection (used to thread comments
    // under tracked changes). Cheaper than a second descendants walk.
    if (commentType && tcMark) {
      const commentMark = node.marks.find((m) => m.type === commentType);
      if (commentMark) {
        const cid = commentMark.attrs.commentId as number;
        const parsedRevisionId = Number(tcMark.attrs.revisionId);
        const rid = Number.isFinite(parsedRevisionId) ? parsedRevisionId : 0;
        if (!commentToRawRevision.has(cid)) commentToRawRevision.set(cid, rid);
      }
    }
  });

  const merged = mergeAdjacentSegments(raw);

  const final: TrackedChangeEntry[] = [];
  const revisionIdToPrimary = new Map<number, number>();

  for (let i = 0; i < merged.length; i++) {
    const curr = merged[i]!;
    const next = merged[i + 1];
    if (next && canFormReplacement(curr, next)) {
      const replacement = buildReplacementEntry(curr, next);
      for (const revisionId of replacement.revisionIds ?? [replacement.revisionId]) {
        revisionIdToPrimary.set(revisionId, replacement.revisionId);
      }
      final.push(replacement);
      i++; // skip the paired segment
      continue;
    }

    const entry = buildSingleEntry(curr);
    for (const revisionId of entry.revisionIds ?? [entry.revisionId]) {
      revisionIdToPrimary.set(revisionId, entry.revisionId);
    }
    final.push(entry);
  }

  const commentToRevision = new Map<number, number>();
  for (const [commentId, rawRevisionId] of commentToRawRevision) {
    commentToRevision.set(commentId, revisionIdToPrimary.get(rawRevisionId) ?? rawRevisionId);
  }

  return { entries: final, commentToRevision, revisionIdToPrimary };
}

/**
 * Returns tracked changes (and the comment→revision overlap + raw-revision
 * alias maps) derived from the latest PM state. Memoized on state identity, so
 * derivation only re-runs when PM state changes (which happens on every
 * doc-changing transaction, including remote ones via ySyncPlugin).
 *
 * No debounce: a single O(N) doc walk, cheap enough to run per transaction. If
 * you see jank on huge documents, wrap the setter that drives the state
 * argument in `requestAnimationFrame` rather than reintroducing a delay here —
 * a delay makes the sidebar feel laggy.
 */
export function useTrackedChanges(state: EditorState | null): TrackedChangesResult {
  return useMemo(() => extractTrackedChanges(state), [state]);
}
