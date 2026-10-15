import { Buffer } from 'buffer';
import type { IWikiWorkspace } from '../../../store/workspace';
import { syncWithStandardGit } from '../standardGitSync';

const OID = 'a'.repeat(40);

const mockExternalStorage: Record<string, jest.Mock | undefined> = {};

jest.mock('expo-tiddlywiki-filesystem-android-external-storage', () => ({
  ExternalStorage: new Proxy({}, { get: (_target, property: string) => mockExternalStorage[property] }),
  toPlainPath: (path: string) => path.replace(/^file:\/\//, ''),
}));

/** Files the sync wrote into the working tree, by file:// URI. */
const mockWrittenFiles = new Map<string, string>();

jest.mock('expo-file-system/legacy', () => ({
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  makeDirectoryAsync: jest.fn(() => Promise.resolve()),
  writeAsStringAsync: jest.fn((uri: string, content: string) => {
    mockWrittenFiles.set(uri, content);
    return Promise.resolve();
  }),
}));

const mockGit = {
  commit: jest.fn(() => Promise.resolve()),
  hasChanges: jest.fn(() => Promise.resolve(false)),
};

jest.mock('../index', () => ({
  ensureGitConfigForMobile: jest.fn(() => Promise.resolve()),
  getCurrentBranch: jest.fn(() => Promise.resolve('main')),
  gitCommit: jest.fn(() => mockGit.commit()),
  gitHasChanges: jest.fn(() => mockGit.hasChanges()),
  isExternalPath: jest.fn(() => false),
  toFileUri: (path: string) => `file://${path}`,
}));

const workspace = { id: 'w1', wikiFolderLocation: 'file:///wikis/w1' } as unknown as IWikiWorkspace;

function housekeepingResult(result: object) {
  return jest.fn(() => Promise.resolve(JSON.stringify(result)));
}

/** A sync where nothing changed on either side: fetch, nothing to merge or push. */
function setUpNoOpSync() {
  mockExternalStorage.gitFetch = jest.fn(() => Promise.resolve(JSON.stringify({ ok: true })));
  mockExternalStorage.gitResolveRef = jest.fn(() => Promise.resolve(JSON.stringify({ ok: true, oid: OID })));
  mockExternalStorage.gitSetConfig = jest.fn(() => Promise.resolve(JSON.stringify({ ok: true })));
}

function resetMocks() {
  for (const key of Object.keys(mockExternalStorage)) mockExternalStorage[key] = undefined;
  mockWrittenFiles.clear();
  mockGit.commit = jest.fn(() => Promise.resolve());
  mockGit.hasChanges = jest.fn(() => Promise.resolve(false));
}

describe('syncWithStandardGit housekeeping', () => {
  beforeEach(() => {
    resetMocks();
    setUpNoOpSync();
  });

  it('turns off JGit background auto-gc and runs housekeeping with Git limits', async () => {
    mockExternalStorage.gitHousekeeping = housekeepingResult({ ok: true, ran: false });
    await expect(syncWithStandardGit(workspace, { headers: null, log: jest.fn() })).resolves.toBe(false);
    expect(mockExternalStorage.gitSetConfig).toHaveBeenCalledWith('/wikis/w1', 'gc', null, 'auto', '0');
    expect(mockExternalStorage.gitSetConfig).toHaveBeenCalledWith('/wikis/w1', 'gc', null, 'autoPackLimit', '0');
    expect(mockExternalStorage.gitHousekeeping).toHaveBeenCalledWith('/wikis/w1', 6700, 50);
  });

  it('leaves JGit auto-gc alone when the native module has no housekeeping', async () => {
    await expect(syncWithStandardGit(workspace, { headers: null, log: jest.fn() })).resolves.toBe(false);
    expect(mockExternalStorage.gitSetConfig).not.toHaveBeenCalledWith(expect.anything(), 'gc', null, expect.anything(), expect.anything());
  });

  it('does not fail the sync when housekeeping fails', async () => {
    const log = jest.fn();
    mockExternalStorage.gitHousekeeping = housekeepingResult({ ok: false, error: 'disk full' });
    await expect(syncWithStandardGit(workspace, { headers: null, log })).resolves.toBe(false);
    mockExternalStorage.gitHousekeeping = jest.fn(() => Promise.reject(new Error('native crash')));
    await expect(syncWithStandardGit(workspace, { headers: null, log })).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith('Standard git: housekeeping failed: disk full');
    expect(log).toHaveBeenCalledWith('Standard git: housekeeping failed: native crash');
  });

  it('announces only housekeeping that takes longer than a second', async () => {
    jest.useFakeTimers();
    try {
      const onHousekeeping = jest.fn();
      mockExternalStorage.gitHousekeeping = housekeepingResult({ ok: true, ran: false });
      await syncWithStandardGit(workspace, { headers: null, log: jest.fn(), onHousekeeping });
      jest.advanceTimersByTime(5000);
      expect(onHousekeeping).not.toHaveBeenCalled();

      let finish: (json: string) => void = () => undefined;
      mockExternalStorage.gitHousekeeping = jest.fn(() =>
        new Promise<string>(resolve => {
          finish = resolve;
        })
      );
      const sync = syncWithStandardGit(workspace, { headers: null, log: jest.fn(), onHousekeeping });
      await jest.advanceTimersByTimeAsync(1500);
      expect(onHousekeeping).toHaveBeenCalledWith(true);
      finish(JSON.stringify({ ok: true, ran: true, packFiles: 51, looseObjects: 10, durationMs: 1500 }));
      await sync;
      expect(onHousekeeping).toHaveBeenLastCalledWith(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('syncWithStandardGit edits saved during a sync', () => {
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
  const tiddler = 'tiddlers/A.tid';
  const blobs: Record<string, string> = {
    base: 'title: A\n\none\ntwo\nthree\n',
    remote: 'title: A\n\none\ntwo\nTHREE from desktop\n',
    late: 'title: A\n\nONE saved during sync\ntwo\nthree\n',
  };

  beforeEach(resetMocks);

  it('commits a tiddler saved after the sync started and merges it instead of overwriting it', async () => {
    // Refs: origin/main is "base" before the fetch and "remote" after it; HEAD follows commits.
    const references = { head: 'base', tracking: 'base' };
    const commits = ['late', 'merged'];
    mockGit.commit = jest.fn(() => {
      references.head = commits.shift() ?? 'extra';
      return Promise.resolve();
    });
    // Nothing to commit when the sync starts; the user saves while it fetches.
    mockGit.hasChanges = jest.fn<Promise<boolean>, []>().mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValue(false);

    const ok = (body: object = {}) => Promise.resolve(JSON.stringify({ ok: true, ...body }));
    mockExternalStorage.gitSetConfig = jest.fn(() => ok());
    mockExternalStorage.gitFetch = jest.fn(() => {
      references.tracking = 'remote';
      return ok();
    });
    mockExternalStorage.gitResolveRef = jest.fn((_directory: string, reference: string) => ok({ oid: reference === 'HEAD' ? references.head : references.tracking }));
    mockExternalStorage.gitDiffTrees = jest.fn(() => ok({ files: [{ path: tiddler, type: 'modify' }] }));
    mockExternalStorage.gitReadBlob = jest.fn((_directory: string, reference: string) => ok({ content: b64(blobs[reference]) }));
    mockExternalStorage.gitCheckoutChangedFiles = jest.fn(() => ok());
    mockExternalStorage.gitReset = jest.fn(() => ok());
    mockExternalStorage.gitPush = jest.fn(() => ok({ updates: [{ status: 'OK' }] }));
    const log = jest.fn();

    await expect(syncWithStandardGit(workspace, { headers: null, log })).resolves.toBe(true);

    expect(log).toHaveBeenCalledWith('Standard git: edits saved during sync committed');
    expect(mockExternalStorage.gitDiffTrees).toHaveBeenCalledWith('/wikis/w1', 'base', 'late');
    const written = mockWrittenFiles.get(`file:///wikis/w1/${tiddler}`);
    expect(written).toBeDefined();
    expect(Buffer.from(written ?? '', 'base64').toString('utf8')).toBe('title: A\n\nONE saved during sync\ntwo\nTHREE from desktop\n');
    expect(mockExternalStorage.gitPush).toHaveBeenCalled();
  });
});
