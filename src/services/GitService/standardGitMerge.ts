/**
 * Per-file merge policy for syncing with standard Git hosts (GitHub, Gitea, …).
 *
 * Mirrors what TidGi Desktop does for mobile changes over LAN (tw-mobile-sync
 * `src/tw-mobile-sync/git/conflictResolution.ts`): a line-based 3-way merge,
 * then marker-based resolution where the remote plays desktop ("ours") and
 * this device plays mobile ("theirs"):
 * - `.tid` header (fields before the first blank line): mobile wins.
 * - `.tid` body: remote lines plus mobile lines that are not already there.
 * - other text files: mobile wins inside conflict blocks.
 * - binary files changed on both sides: remote wins (what `git merge` leaves).
 * - modified on one side, deleted on the other: the modification wins.
 */
import { Buffer } from 'buffer';
import { merge3 } from './diff3';

export const REMOTE_CONFLICT_LABEL = 'remote';
export const MOBILE_CONFLICT_LABEL = 'mobile';

/** File content as base64 (what the native module returns), or undefined when the file is absent. */
export interface IFileVersions {
  base?: string;
  local?: string;
  path: string;
  remote?: string;
}

export type FileMergeDecision =
  | { action: 'keep-remote' }
  | { action: 'delete' }
  | { action: 'write'; base64: string; conflict: boolean };

/**
 * Decide the merged content of one path that changed locally since the last sync.
 * The working tree is assumed to hold the remote version already.
 */
export function mergeFileVersions({ path, base, local, remote }: IFileVersions): FileMergeDecision {
  if (local === remote) return { action: 'keep-remote' };
  // Remote did not touch it: the local change applies as-is.
  if (remote === base) {
    return local === undefined ? { action: 'delete' } : { action: 'write', base64: local, conflict: false };
  }
  // Both changed. A deletion loses against a modification.
  if (local === undefined) return { action: 'keep-remote' };
  if (remote === undefined) return { action: 'write', base64: local, conflict: false };

  const baseBytes = base === undefined ? undefined : Buffer.from(base, 'base64');
  const localBytes = Buffer.from(local, 'base64');
  const remoteBytes = Buffer.from(remote, 'base64');
  if (isBinary(localBytes) || isBinary(remoteBytes) || (baseBytes !== undefined && isBinary(baseBytes))) {
    return { action: 'keep-remote' };
  }

  const merged = merge3(
    baseBytes === undefined ? [] : baseBytes.toString('utf8').split('\n'),
    remoteBytes.toString('utf8').split('\n'),
    localBytes.toString('utf8').split('\n'),
    { ours: REMOTE_CONFLICT_LABEL, theirs: MOBILE_CONFLICT_LABEL },
  );
  let text = merged.lines.join('\n');
  if (merged.conflict) {
    text = path.endsWith('.tid')
      ? resolveTidConflictMarkers(text, { mergeHeaderBodyConflicts: true })
      : resolveConflictPreferMobile(text);
  }
  return { action: 'write', base64: Buffer.from(text, 'utf8').toString('base64'), conflict: merged.conflict };
}

/** Git's heuristic: a NUL byte in the first 8000 bytes means binary. */
function isBinary(bytes: Uint8Array): boolean {
  const length = Math.min(bytes.length, 8000);
  for (let index = 0; index < length; index++) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

// ── Copied from tw-mobile-sync conflictResolution.ts (keep in sync) ──────────

interface TidConflictOptions {
  /**
   * When true and a conflict block starts in the header but contains a blank-line
   * separator in EITHER ours or theirs, the block is split: header keeps theirs,
   * body merges ours lines + unique theirs lines.
   * Default false: entire block prefers theirs (add/add mobile-wins behaviour).
   */
  mergeHeaderBodyConflicts?: boolean;
}

/**
 * Split a list of lines at the first blank line into [headerLines, bodyLines].
 * The blank line itself is excluded from both parts.
 */
function splitAtBlankLine(lines: string[]): { body: string[]; header: string[] } {
  const blankIndex = lines.indexOf('');
  if (blankIndex === -1) {
    return { header: lines, body: [] };
  }
  return {
    header: lines.slice(0, blankIndex),
    body: lines.slice(blankIndex + 1),
  };
}

/**
 * .tid conflict marker resolution.
 *
 * - Header section (before the first blank line): mobile ("theirs") wins entirely.
 * - Body section (after the first blank line): merge both sides, keeping desktop lines plus unique mobile lines.
 * - When `options.mergeHeaderBodyConflicts` is true and a conflict block starts in
 *   the header but spans into the body, the block is split at the blank line:
 *   header → theirs wins, body → merge ours + unique theirs.
 */
export function resolveTidConflictMarkers(content: string, options: TidConflictOptions = {}): string {
  content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const { mergeHeaderBodyConflicts = false } = options;
  const lines = content.split('\n');
  const resolved: string[] = [];
  let passedBlankLine = false;
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const line = lines[lineIndex];

    if (!line.startsWith('<<<<<<<')) {
      if (!passedBlankLine && line === '') {
        passedBlankLine = true;
      }
      resolved.push(line);
      lineIndex++;
      continue;
    }

    const conflictIsInBody = passedBlankLine;
    const oursLines: string[] = [];
    const theirsLines: string[] = [];
    let conflictSection: 'done' | 'ours' | 'theirs' = 'ours';

    lineIndex++;
    while (lineIndex < lines.length && conflictSection !== 'done') {
      const conflictLine = lines[lineIndex];
      if (conflictLine.startsWith('=======') && conflictSection === 'ours') {
        conflictSection = 'theirs';
      } else if (conflictLine.startsWith('>>>>>>>') && conflictSection === 'theirs') {
        conflictSection = 'done';
      } else if (conflictSection === 'ours') {
        oursLines.push(conflictLine);
      } else {
        theirsLines.push(conflictLine);
      }
      lineIndex++;
    }

    if (conflictIsInBody) {
      resolved.push(...oursLines);
      for (const theirsLine of theirsLines) {
        if (!oursLines.includes(theirsLine)) {
          resolved.push(theirsLine);
        }
      }
    } else if (mergeHeaderBodyConflicts) {
      const { body: oursBody } = splitAtBlankLine(oursLines);
      const { header: theirsHeader, body: theirsBody } = splitAtBlankLine(theirsLines);

      if (oursBody.length > 0 || theirsBody.length > 0) {
        resolved.push(...theirsHeader);
        resolved.push('');
        resolved.push(...oursBody);
        for (const theirsBodyLine of theirsBody) {
          if (!oursBody.includes(theirsBodyLine)) {
            resolved.push(theirsBodyLine);
          }
        }
        passedBlankLine = true;
      } else {
        resolved.push(...theirsLines);
        if (!passedBlankLine && theirsLines.includes('')) {
          passedBlankLine = true;
        }
      }
    } else {
      resolved.push(...theirsLines);
      if (!passedBlankLine && theirsLines.includes('')) {
        passedBlankLine = true;
      }
    }
  }

  return resolved.join('\n');
}

/** Non-.tid fallback: prefer mobile ("theirs") for all conflict sections. */
export function resolveConflictPreferMobile(content: string): string {
  const lines = content.split('\n');
  const resolved: string[] = [];
  let section: 'normal' | 'ours' | 'theirs' = 'normal';
  for (const line of lines) {
    if (line.startsWith('<<<<<<<')) {
      section = 'ours';
    } else if (line.startsWith('=======') && section === 'ours') {
      section = 'theirs';
    } else if (line.startsWith('>>>>>>>') && section === 'theirs') {
      section = 'normal';
    } else if (section !== 'ours') {
      resolved.push(line);
    }
  }
  return resolved.join('\n');
}
