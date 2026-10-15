import { parseGitHostRepository } from '../gitHostRepository';

describe('parseGitHostRepository', () => {
  it('expands owner/repo to GitHub', () => {
    expect(parseGitHostRepository('alice/notes', 'tok')).toEqual({
      baseUrl: 'https://github.com',
      gitUrl: 'https://github.com/alice/notes.git',
      workspaceId: expect.stringMatching(/^notes-[0-9a-z]+$/) as string,
      workspaceName: 'notes',
      token: 'tok',
    });
  });

  it('accepts GitHub URLs with or without scheme, trailing slash or .git', () => {
    for (const input of ['https://github.com/alice/notes', 'github.com/alice/notes/', ' https://github.com/alice/notes.git ']) {
      expect(parseGitHostRepository(input, '')?.gitUrl).toBe('https://github.com/alice/notes.git');
    }
  });

  it('keeps other hosts as typed', () => {
    const data = parseGitHostRepository('https://gitea.example.org/team/wiki.git', '');
    expect(data?.baseUrl).toBe('https://gitea.example.org');
    expect(data?.gitUrl).toBe('https://gitea.example.org/team/wiki.git');
    expect(data?.workspaceName).toBe('wiki');
  });

  it('leaves the token out when none is given (public repositories)', () => {
    expect(parseGitHostRepository('alice/notes', '  ')).not.toHaveProperty('token');
  });

  it('rejects input that is not a repository URL', () => {
    for (const input of ['', '   ', 'notes', 'https://github.com/', 'https://github.com/alice', 'localhost/alice/notes', 'ftp://x']) {
      expect(parseGitHostRepository(input, 'tok')).toBeUndefined();
    }
  });
});
