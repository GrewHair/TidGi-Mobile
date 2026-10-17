/**
 * Line-based three-way merge (diff3) for syncing with standard Git hosts.
 *
 * Desktop merges with `git merge`; mobile has no merge in its native JGit
 * module, so the standard-Git sync path merges text files here instead and
 * then applies the same conflict policy as the tw-mobile-sync plugin.
 *
 * Self-contained on purpose: no dependency means no lockfile churn.
 */

/** A region where `other` differs from `base`. Ranges are half-open line indexes. */
export interface IDiffHunk {
  baseEnd: number;
  baseStart: number;
  otherEnd: number;
  otherStart: number;
}

/**
 * Myers search is O(D²) in memory. Beyond this many edits, treat the
 * differing middle as one hunk: the merge still works, it is just coarser.
 */
const MAX_EDIT_DISTANCE = 1000;

/** Diff two line arrays into the hunks where `other` differs from `base`. */
export function diffLines(base: readonly string[], other: readonly string[]): IDiffHunk[] {
  // Trim the common prefix and suffix first: typical edits touch a few lines.
  let prefix = 0;
  while (prefix < base.length && prefix < other.length && base[prefix] === other[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < base.length - prefix &&
    suffix < other.length - prefix &&
    base[base.length - 1 - suffix] === other[other.length - 1 - suffix]
  ) suffix++;

  const baseEnd = base.length - suffix;
  const otherEnd = other.length - suffix;
  if (prefix === baseEnd && prefix === otherEnd) return [];

  const matches = myersMatches(base, other, prefix, baseEnd, prefix, otherEnd);
  if (matches === undefined) {
    return [{ baseStart: prefix, baseEnd, otherStart: prefix, otherEnd }];
  }

  const hunks: IDiffHunk[] = [];
  let previousBase = prefix - 1;
  let previousOther = prefix - 1;
  for (const [baseIndex, otherIndex] of [...matches, [baseEnd, otherEnd] as const]) {
    if (baseIndex > previousBase + 1 || otherIndex > previousOther + 1) {
      hunks.push({ baseStart: previousBase + 1, baseEnd: baseIndex, otherStart: previousOther + 1, otherEnd: otherIndex });
    }
    previousBase = baseIndex;
    previousOther = otherIndex;
  }
  return hunks;
}

/**
 * Myers' O(ND) diff over a[aStart..aEnd) and b[bStart..bEnd).
 * Returns matched index pairs in ascending order, or undefined when the edit
 * distance exceeds MAX_EDIT_DISTANCE.
 */
function myersMatches(
  a: readonly string[],
  b: readonly string[],
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): Array<readonly [number, number]> | undefined {
  const n = aEnd - aStart;
  const m = bEnd - bStart;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds V for diagonals -d-1..d+1 as it was at the start of step d.
  const trace: Int32Array[] = [];
  let finalD = -1;

  search:
  for (let d = 0; d <= Math.min(max, MAX_EDIT_DISTANCE); d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[aStart + x] === b[bStart + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        finalD = d;
        break search;
      }
    }
  }
  if (finalD === -1) return undefined;

  const matches: Array<readonly [number, number]> = [];
  let x = n;
  let y = m;
  for (let d = finalD; d > 0; d--) {
    const previous = trace[d];
    const at = (k: number) => previous[k + d + 1];
    const k = x - y;
    const previousK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x--;
      y--;
      matches.push([aStart + x, bStart + y]);
    }
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    matches.push([aStart + x, bStart + y]);
  }
  return matches.reverse();
}

export interface IMerge3Labels {
  ours: string;
  theirs: string;
}

export interface IMerge3Result {
  conflict: boolean;
  lines: string[];
}

/**
 * Three-way merge of line arrays. Non-overlapping changes from both sides are
 * combined; overlapping, differing changes become a Git-style conflict block
 * (`<<<<<<< ours` / `=======` / `>>>>>>> theirs`) so the existing marker-based
 * resolvers can handle them.
 */
export function merge3(
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
  labels: IMerge3Labels = { ours: 'ours', theirs: 'theirs' },
): IMerge3Result {
  type Side = 'ours' | 'theirs';
  const tagged = [
    ...diffLines(base, ours).map(hunk => ({ ...hunk, side: 'ours' as Side })),
    ...diffLines(base, theirs).map(hunk => ({ ...hunk, side: 'theirs' as Side })),
  ].sort((left, right) => left.baseStart - right.baseStart || left.baseEnd - right.baseEnd);

  const sideLines: Record<Side, readonly string[]> = { ours, theirs };
  // Lines added minus lines removed by each side's hunks so far: maps base positions to side positions.
  const delta: Record<Side, number> = { ours: 0, theirs: 0 };
  const lines: string[] = [];
  let conflict = false;
  let cursor = 0;
  let index = 0;

  while (index < tagged.length) {
    const regionStart = tagged[index].baseStart;
    let regionEnd = tagged[index].baseEnd;
    const group = [tagged[index]];
    index++;
    // Hunks from one side never touch each other, so this only chains across sides.
    while (index < tagged.length && tagged[index].baseStart <= regionEnd) {
      regionEnd = Math.max(regionEnd, tagged[index].baseEnd);
      group.push(tagged[index]);
      index++;
    }

    lines.push(...base.slice(cursor, regionStart));

    const sliceFor = (side: Side): string[] => {
      const groupDelta = group
        .filter(hunk => hunk.side === side)
        .reduce((sum, hunk) => sum + (hunk.otherEnd - hunk.otherStart) - (hunk.baseEnd - hunk.baseStart), 0);
      const start = regionStart + delta[side];
      const slice = sideLines[side].slice(start, regionEnd + delta[side] + groupDelta);
      delta[side] += groupDelta;
      return slice;
    };
    const touched = new Set(group.map(hunk => hunk.side));
    const oursSlice = sliceFor('ours');
    const theirsSlice = sliceFor('theirs');

    if (!touched.has('theirs')) {
      lines.push(...oursSlice);
    } else if (!touched.has('ours')) {
      lines.push(...theirsSlice);
    } else if (oursSlice.length === theirsSlice.length && oursSlice.every((line, lineIndex) => line === theirsSlice[lineIndex])) {
      lines.push(...oursSlice);
    } else {
      conflict = true;
      lines.push(...refineConflict(oursSlice, theirsSlice, labels));
    }
    cursor = regionEnd;
  }

  lines.push(...base.slice(cursor));
  return { conflict, lines };
}

/**
 * Shrink a conflict to the lines where the two sides really differ, like Git's
 * "zealous" merge level: lines both sides agree on stay outside the markers.
 */
function refineConflict(ours: readonly string[], theirs: readonly string[], labels: IMerge3Labels): string[] {
  const lines: string[] = [];
  let oursCursor = 0;
  for (const hunk of diffLines(ours, theirs)) {
    lines.push(
      ...ours.slice(oursCursor, hunk.baseStart),
      `<<<<<<< ${labels.ours}`,
      ...ours.slice(hunk.baseStart, hunk.baseEnd),
      '=======',
      ...theirs.slice(hunk.otherStart, hunk.otherEnd),
      `>>>>>>> ${labels.theirs}`,
    );
    oursCursor = hunk.baseEnd;
  }
  lines.push(...ours.slice(oursCursor));
  return lines;
}
