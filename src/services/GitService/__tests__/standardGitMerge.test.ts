import { Buffer } from 'buffer';
import { mergeFileVersions } from '../standardGitMerge';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const text = (base64: string) => Buffer.from(base64, 'base64').toString('utf8');
const binary = (...bytes: number[]) => Buffer.from(bytes).toString('base64');

function mergedText(path: string, base: string | undefined, remote: string | undefined, local: string | undefined): string {
  const decision = mergeFileVersions({
    path,
    base: base === undefined ? undefined : b64(base),
    remote: remote === undefined ? undefined : b64(remote),
    local: local === undefined ? undefined : b64(local),
  });
  if (decision.action !== 'write') throw new Error(`expected write, got ${decision.action}`);
  return text(decision.base64);
}

describe('mergeFileVersions', () => {
  const tid = (fields: string, body: string) => `${fields}\n\n${body}\n`;

  it('applies a local change when the remote did not touch the file', () => {
    expect(mergedText('tiddlers/A.tid', tid('title: A', 'old'), tid('title: A', 'old'), tid('title: A', 'new'))).toBe(tid('title: A', 'new'));
  });

  it('deletes when deleted locally and unchanged remotely', () => {
    expect(mergeFileVersions({ path: 'a.tid', base: b64('x'), remote: b64('x'), local: undefined })).toEqual({ action: 'delete' });
  });

  it('keeps the remote when both sides made the same change', () => {
    expect(mergeFileVersions({ path: 'a.tid', base: b64('x'), remote: b64('y'), local: b64('y') })).toEqual({ action: 'keep-remote' });
  });

  it('combines edits to different lines of the same tiddler', () => {
    const base = tid('title: A', 'one\ntwo\nthree\nfour');
    const remote = tid('title: A', 'ONE\ntwo\nthree\nfour');
    const local = tid('title: A', 'one\ntwo\nthree\nFOUR');
    expect(mergedText('A.tid', base, remote, local)).toBe(tid('title: A', 'ONE\ntwo\nthree\nFOUR'));
  });

  it('resolves a .tid body conflict by keeping remote lines plus unique mobile lines', () => {
    const base = tid('title: A', 'line');
    const merged = mergedText('A.tid', base, tid('title: A', 'remote line'), tid('title: A', 'mobile line'));
    expect(merged).toBe(tid('title: A', 'remote line\nmobile line'));
    expect(merged).not.toContain('<<<<<<<');
  });

  it('resolves a .tid header conflict in favour of mobile', () => {
    const base = tid('title: A\nmodified: 1', 'body');
    const merged = mergedText('A.tid', base, tid('title: A\nmodified: 2', 'body'), tid('title: A\nmodified: 3', 'body'));
    expect(merged).toBe(tid('title: A\nmodified: 3', 'body'));
  });

  it('prefers mobile inside conflicts in non-.tid text files', () => {
    expect(mergedText('a.json', '{"v":1}', '{"v":2}', '{"v":3}')).toBe('{"v":3}');
  });

  it('keeps a modification over a deletion on either side', () => {
    expect(mergeFileVersions({ path: 'a.tid', base: b64('x'), remote: b64('y'), local: undefined })).toEqual({ action: 'keep-remote' });
    expect(mergeFileVersions({ path: 'a.tid', base: b64('x'), remote: undefined, local: b64('z') })).toEqual({ action: 'write', base64: b64('z'), conflict: false });
  });

  it('keeps the remote version of a binary file changed on both sides', () => {
    expect(mergeFileVersions({ path: 'a.png', base: binary(1, 0, 2), remote: binary(1, 0, 3), local: binary(1, 0, 4) })).toEqual({ action: 'keep-remote' });
  });

  it('merges a file added on both sides as text', () => {
    const merged = mergedText('New.tid', undefined, tid('title: New', 'remote'), tid('title: New', 'mobile'));
    expect(merged).toBe(tid('title: New', 'remote\nmobile'));
  });
});
