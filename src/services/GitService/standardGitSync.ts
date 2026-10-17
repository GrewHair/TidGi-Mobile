/**
 * Sync with a standard Git host (GitHub, Gitea, …) without losing local edits.
 *
 * Same shape as TidGi Desktop's git-sync-js: commit → fetch → fast-forward or
 * rebase → push. The native module has no merge or rebase, so "rebase" is done
 * per file: the working tree moves to the remote commit, then every file this
 * device changed since the last sync is re-applied through the 3-way merge
 * policy in standardGitMerge.ts and committed on top. History stays linear and
 * nothing is ever force-pushed.
 *
 * The merge base is `origin/<branch>` as it was before fetching: after every
 * sync HEAD is built on top of it, so it is the last commit both sides shared.
 * That also holds in a shallow clone, where Git itself could not compute one.
 */
import * as FileSystemLegacy from 'expo-file-system/legacy';
import { ExternalStorage, toPlainPath } from 'expo-tiddlywiki-filesystem-android-external-storage';
import type { IWikiWorkspace } from '../../store/workspace';
import { ensureGitConfigForMobile, getCurrentBranch, gitCommit, gitHasChanges, isExternalPath, toFileUri } from './index';
import { mergeFileVersions } from './standardGitMerge';

export interface IStandardGitSyncOptions {
  /** JSON-encoded HTTP headers for the native transport (see headersToJson). */
  headers: string | null;
  log: (message: string) => void;
  /** Retries when another device pushes between our fetch and push. */
  maxAttempts?: number;
  /**
   * Told when repository housekeeping is under way (true) and done (false), so
   * the UI can say why this sync takes longer. Only called when it lasts over a
   * second; the usual "nothing to do" check stays silent.
   */
  onHousekeeping?: (running: boolean) => void;
}

/** Ref kept pointing at the last local commit before a merge rewrote the working tree. */
export const PRE_SYNC_BACKUP_REF = 'refs/tidgi/pre-sync';

/** Git's own `gc --auto` limits (gc.auto, gc.autoPackLimit). */
const HOUSEKEEPING_LOOSE_OBJECT_LIMIT = 6700;
const HOUSEKEEPING_PACK_LIMIT = 50;
const HOUSEKEEPING_ANNOUNCE_DELAY_MS = 1000;

const PUSH_ACCEPTED = new Set(['OK', 'UP_TO_DATE']);
const PUSH_RACED = new Set(['REJECTED_NONFASTFORWARD', 'REJECTED_REMOTE_CHANGED']);

/** @returns true when remote changes were brought into the working tree. */
export async function syncWithStandardGit(workspace: IWikiWorkspace, options: IStandardGitSyncOptions): Promise<boolean> {
  const directory = toPlainPath(workspace.wikiFolderLocation);
  const haveUpdate = await commitFetchMergePush(workspace, directory, options);
  await runHousekeeping(directory, workspace.keepOnlyRecentHistory === true, options);
  return haveUpdate;
}

async function commitFetchMergePush(workspace: IWikiWorkspace, directory: string, options: IStandardGitSyncOptions): Promise<boolean> {
  const { headers, log, maxAttempts = 3 } = options;

  if (await commitPendingEdits(workspace)) log('Standard git: local changes committed');
  await ensureGitConfigForMobile(directory);
  await disableBackgroundAutoGc(directory);
  const branch = await getCurrentBranch(directory);
  const trackingReference = `refs/remotes/origin/${branch}`;

  let haveUpdate = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const base = await resolveReference(directory, trackingReference);

    log(`Standard git: fetching origin/${branch}`);
    const fetchResult = parseJson<{ ok: boolean; error?: string }>(await ExternalStorage.gitFetch(directory, 'origin', branch, headers));
    if (!fetchResult.ok) throw new Error(`git fetch failed: ${fetchResult.error ?? 'unknown'}`);

    const remote = await resolveReference(directory, trackingReference);
    let head = await resolveReference(directory, 'HEAD');
    if (remote === '') throw new Error(`Remote branch ${branch} not found`);

    if (remote !== base && head !== remote) {
      // The wiki stays editable during a sync. A tiddler saved since the commit
      // above would be overwritten by the remote's version below, so commit it
      // now and let it go through the merge like any other local change.
      if (await commitPendingEdits(workspace)) {
        log('Standard git: edits saved during sync committed');
        head = await resolveReference(directory, 'HEAD');
      }
      if (head === base) {
        log(`Standard git: fast-forward ${short(head)}..${short(remote)}`);
        await moveWorkingTree(directory, head, remote);
      } else {
        if (base === '') throw new Error(`No previous sync point for ${branch}; cannot merge unrelated histories`);
        log(`Standard git: both sides changed since ${short(base)}, merging`);
        await rebuildOnRemote(workspace, directory, { base, head, remote }, log);
      }
      haveUpdate = true;
    }

    if (await resolveReference(directory, 'HEAD') === remote) return haveUpdate;

    log(`Standard git: pushing to origin/${branch}`);
    const pushResult = parseJson<{ ok: boolean; error?: string; updates?: Array<{ status: string; message?: string }> }>(
      await ExternalStorage.gitPush(directory, 'origin', branch, `refs/heads/${branch}`, false, headers),
    );
    if (!pushResult.ok) throw new Error(`git push failed: ${pushResult.error ?? 'unknown'}`);
    const statuses = (pushResult.updates ?? []).map(update => update.status);
    if (statuses.every(status => PUSH_ACCEPTED.has(status))) {
      log('Standard git: push succeeded');
      return haveUpdate;
    }
    if (!statuses.some(status => PUSH_RACED.has(status))) {
      throw new Error(`git push rejected: ${JSON.stringify(pushResult.updates)}`);
    }
    log(`Standard git: remote moved during sync (attempt ${attempt}/${maxAttempts}), retrying`);
  }
  throw new Error(`git push kept being rejected after ${maxAttempts} attempts`);
}

/** @returns true when there were uncommitted edits, now committed. */
async function commitPendingEdits(workspace: IWikiWorkspace): Promise<boolean> {
  if (!(await gitHasChanges(workspace))) return false;
  await gitCommit(workspace, `Mobile sync at ${new Date().toISOString()}`);
  return true;
}

/**
 * JGit runs auto-gc after every fetch on a background thread, outside the
 * native repository lock, keeping replaced packs for an hour. Under frequent
 * syncs that can leave several full copies of the repository on disk, so turn
 * it off for this repository and run the same housekeeping ourselves after the
 * sync (runHousekeeping). Only when the native module can do that: otherwise
 * JGit's own auto-gc stays on.
 */
async function disableBackgroundAutoGc(directory: string): Promise<void> {
  if (ExternalStorage.gitHousekeeping === undefined) return;
  await ExternalStorage.gitSetConfig(directory, 'gc', null, 'auto', '0');
  await ExternalStorage.gitSetConfig(directory, 'gc', null, 'autoPackLimit', '0');
}

/**
 * `git gc --auto` under the native repository lock, once Git's usual limits
 * are reached. With `dropHistory` (the workspace's "keep only recent history"
 * setting) it also drops commits older than HEAD while in step with the remote,
 * so history on the phone only reaches back to the last housekeeping.
 * A failure here never fails the sync: the next one retries.
 */
async function runHousekeeping(directory: string, dropHistory: boolean, options: IStandardGitSyncOptions): Promise<void> {
  const { log, onHousekeeping } = options;
  if (ExternalStorage.gitHousekeeping === undefined) return;
  const announcement = { shown: false };
  const announce = setTimeout(() => {
    announcement.shown = true;
    onHousekeeping?.(true);
  }, HOUSEKEEPING_ANNOUNCE_DELAY_MS);
  try {
    const result = parseJson<{ ok: boolean; ran?: boolean; historyDropped?: boolean; error?: string; looseObjects?: number; packFiles?: number; durationMs?: number }>(
      await ExternalStorage.gitHousekeeping(directory, HOUSEKEEPING_LOOSE_OBJECT_LIMIT, HOUSEKEEPING_PACK_LIMIT, dropHistory),
    );
    if (!result.ok) {
      log(`Standard git: housekeeping failed: ${result.error ?? 'unknown'}`);
    } else if (result.ran === true) {
      const dropped = result.historyDropped === true ? ', dropping older history' : '';
      log(`Standard git: housekeeping repacked ${result.packFiles ?? '?'} packs and ${result.looseObjects ?? '?'} loose objects${dropped} in ${result.durationMs ?? '?'} ms`);
    }
  } catch (error) {
    log(`Standard git: housekeeping failed: ${(error as Error).message}`);
  } finally {
    clearTimeout(announce);
    if (announcement.shown) onHousekeeping?.(false);
  }
}

/**
 * Put this device's changes (base..head) on top of `remote`, leaving one new
 * commit whose parent is `remote`.
 */
async function rebuildOnRemote(
  workspace: IWikiWorkspace,
  directory: string,
  commits: { base: string; head: string; remote: string },
  log: (message: string) => void,
): Promise<void> {
  const { base, head, remote } = commits;
  const localChanges = await diffTrees(directory, base, head);
  const remoteChanges = await diffTrees(directory, base, remote);

  // Read everything we need before the working tree changes underneath us.
  const plans = await Promise.all([...localChanges].map(async ([path, type]) => {
    const baseVersion = type === 'add' ? undefined : await readBlob(directory, base, path);
    const localVersion = type === 'delete' ? undefined : await readBlob(directory, head, path);
    const remoteVersion = remoteChanges.has(path) ? await readBlob(directory, remote, path) : baseVersion;
    return { path, decision: mergeFileVersions({ path, base: baseVersion, local: localVersion, remote: remoteVersion }) };
  }));

  await writeRepositoryFile(directory, `.git/${PRE_SYNC_BACKUP_REF}`, `${head}\n`);
  await moveWorkingTree(directory, head, remote);

  let conflicts = 0;
  for (const { path, decision } of plans) {
    if (decision.action === 'write') {
      await writeRepositoryFile(directory, path, decision.base64, 'base64');
      if (decision.conflict) conflicts++;
    } else if (decision.action === 'delete') {
      await deleteRepositoryFile(directory, path);
    }
  }
  log(`Standard git: re-applied ${plans.length} local file(s), ${conflicts} auto-resolved conflict(s)`);
  await gitCommit(workspace, `Mobile sync merge at ${new Date().toISOString()}`);
}

/** Make the working tree, index and branch match `target` (tracked files only). */
async function moveWorkingTree(directory: string, from: string, target: string): Promise<void> {
  const checkout = parseJson<{ ok: boolean; error?: string }>(await ExternalStorage.gitCheckoutChangedFiles(directory, from, target));
  if (!checkout.ok) throw new Error(`Working tree update failed: ${checkout.error ?? 'unknown'}`);
  const reset = parseJson<{ ok: boolean; error?: string }>(await ExternalStorage.gitReset(directory, target, 'mixed'));
  if (!reset.ok) throw new Error(`git reset to ${short(target)} failed: ${reset.error ?? 'unknown'}`);
}

async function resolveReference(directory: string, reference: string): Promise<string> {
  const result = parseJson<{ ok: boolean; oid?: string }>(await ExternalStorage.gitResolveRef(directory, reference));
  return result.ok ? (result.oid ?? '') : '';
}

async function diffTrees(directory: string, from: string, to: string): Promise<Map<string, 'add' | 'delete' | 'modify'>> {
  const result = parseJson<{ ok: boolean; error?: string; files?: Array<{ path: string; type: 'add' | 'delete' | 'modify'; oldPath?: string }> }>(
    await ExternalStorage.gitDiffTrees(directory, from, to),
  );
  if (!result.ok) throw new Error(`git diff ${short(from)}..${short(to)} failed: ${result.error ?? 'unknown'}`);
  const changes = new Map<string, 'add' | 'delete' | 'modify'>();
  for (const file of result.files ?? []) {
    if (file.oldPath !== undefined && file.oldPath !== file.path) {
      changes.set(file.oldPath, 'delete');
      changes.set(file.path, 'add');
    } else {
      changes.set(file.path, file.type);
    }
  }
  return changes;
}

/** @returns base64 content, or undefined when the path does not exist in that commit. */
async function readBlob(directory: string, reference: string, path: string): Promise<string | undefined> {
  const result = parseJson<{ ok: boolean; content?: string; error?: string }>(await ExternalStorage.gitReadBlob(directory, reference, path, true));
  if (result.ok) return result.content ?? '';
  if (result.error?.startsWith('File not found') === true) return undefined;
  throw new Error(`Reading ${path} at ${short(reference)} failed: ${result.error ?? 'unknown'}`);
}

async function writeRepositoryFile(directory: string, relativePath: string, content: string, encoding: 'base64' | 'utf8' = 'utf8'): Promise<void> {
  const path = `${directory}/${relativePath}`;
  const parent = path.slice(0, path.lastIndexOf('/'));
  if (isExternalPath(directory)) {
    if (!(await ExternalStorage.exists(parent))) await ExternalStorage.mkdir(parent);
    await (encoding === 'base64' ? ExternalStorage.writeFileBase64(path, content) : ExternalStorage.writeFileUtf8(path, content));
    return;
  }
  await FileSystemLegacy.makeDirectoryAsync(toFileUri(parent), { intermediates: true });
  await FileSystemLegacy.writeAsStringAsync(toFileUri(path), content, {
    encoding: encoding === 'base64' ? FileSystemLegacy.EncodingType.Base64 : FileSystemLegacy.EncodingType.UTF8,
  });
}

async function deleteRepositoryFile(directory: string, relativePath: string): Promise<void> {
  const path = `${directory}/${relativePath}`;
  if (isExternalPath(directory)) {
    if (await ExternalStorage.exists(path)) await ExternalStorage.deleteFile(path);
    return;
  }
  await FileSystemLegacy.deleteAsync(toFileUri(path), { idempotent: true });
}

function short(oid: string): string {
  return oid === '' ? '(none)' : oid.slice(0, 8);
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function parseJson<T>(json: string): T {
  return JSON.parse(json) as T;
}
