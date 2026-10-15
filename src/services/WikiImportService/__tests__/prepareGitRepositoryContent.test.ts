import { prepareGitRepositoryContent } from '../index';

const mockGitSetConfig = jest.fn((..._arguments: unknown[]) => Promise.resolve(JSON.stringify({ ok: true })));
const mockGitCloneToDirectory = jest.fn((..._arguments: unknown[]) => Promise.resolve());
const mockHasValidGitRepository = jest.fn((..._arguments: unknown[]) => Promise.resolve(true));

jest.mock('expo-tiddlywiki-filesystem-android-external-storage', () => ({
  ExternalStorage: { gitSetConfig: (...arguments_: unknown[]) => mockGitSetConfig(...arguments_) },
  toPlainPath: (path: string) => path.replace(/^file:\/\//, ''),
}));
jest.mock('expo-file-system/legacy', () => ({
  deleteAsync: jest.fn(() => Promise.resolve()),
  getInfoAsync: jest.fn(() => Promise.resolve({ exists: false })),
  makeDirectoryAsync: jest.fn(() => Promise.resolve()),
  readDirectoryAsync: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../../../constants/paths', () => ({ WIKI_FOLDER_PATH: 'file:///wikis/' }));
jest.mock('../../../store/workspace', () => ({ useWorkspaceStore: { getState: jest.fn() } }));
jest.mock('../../GitService', () => ({ gitCloneToDirectory: (...arguments_: unknown[]) => mockGitCloneToDirectory(...arguments_) }));
jest.mock('../../WikiStorageService/tidgiConfigManager', () => ({ saveTidgiConfig: jest.fn() }));
jest.mock('../../WikiTemplateService/extractLocalWikiTemplate', () => ({ extractZipToDirectory: jest.fn() }));
jest.mock('../gitCloneCache', () => ({
  getGitCloneCacheDirectory: () => '/cache/git-clone-cache/abc',
  hasValidGitRepository: (...arguments_: unknown[]) => mockHasValidGitRepository(...arguments_),
  normalizeGitCloneUrl: (url: string) => url,
  toFileCloneUrl: (directory: string) => `file://${directory}`,
  updateGitCloneCache: jest.fn(() => Promise.resolve()),
}));

const remote = { baseUrl: 'https://github.com', gitUrl: 'https://github.com/alice/notes.git', workspaceId: 'notes-1', token: 'tok' };

describe('prepareGitRepositoryContent', () => {
  it('points origin at the real remote after restoring from the clone cache', async () => {
    await prepareGitRepositoryContent({ targetDirectory: 'file:///wikis/notes-1', remote, useStandardGitProtocol: true });
    expect(mockGitCloneToDirectory).toHaveBeenCalledTimes(1);
    expect(mockGitCloneToDirectory.mock.calls[0][1]).toMatchObject({ gitUrl: 'file:///cache/git-clone-cache/abc' });
    expect(mockGitSetConfig).toHaveBeenCalledWith('/wikis/notes-1', 'remote', 'origin', 'url', 'https://github.com/alice/notes.git');
  });
});
