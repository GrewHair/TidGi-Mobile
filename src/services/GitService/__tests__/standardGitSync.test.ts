import type { IWikiWorkspace } from '../../../store/workspace';
import { syncWithStandardGit } from '../standardGitSync';

const OID = 'a'.repeat(40);

const mockExternalStorage: Record<string, jest.Mock | undefined> = {};

jest.mock('expo-tiddlywiki-filesystem-android-external-storage', () => ({
  ExternalStorage: new Proxy({}, { get: (_target, property: string) => mockExternalStorage[property] }),
  toPlainPath: (path: string) => path.replace(/^file:\/\//, ''),
}));

jest.mock('expo-file-system/legacy', () => ({ EncodingType: { Base64: 'base64', UTF8: 'utf8' } }));

jest.mock('../index', () => ({
  ensureGitConfigForMobile: jest.fn(() => Promise.resolve()),
  getCurrentBranch: jest.fn(() => Promise.resolve('main')),
  gitCommit: jest.fn(() => Promise.resolve()),
  gitHasChanges: jest.fn(() => Promise.resolve(false)),
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

describe('syncWithStandardGit housekeeping', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockExternalStorage)) mockExternalStorage[key] = undefined;
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
