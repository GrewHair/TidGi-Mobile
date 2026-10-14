import { diffLines, merge3 } from '../diff3';

const lines = (text: string) => text.split('\n');

/** Apply hunks produced by diffLines to base; must reproduce other. */
function applyHunks(base: string[], other: string[]): string[] {
  const result: string[] = [];
  let cursor = 0;
  for (const hunk of diffLines(base, other)) {
    result.push(...base.slice(cursor, hunk.baseStart), ...other.slice(hunk.otherStart, hunk.otherEnd));
    cursor = hunk.baseEnd;
  }
  return [...result, ...base.slice(cursor)];
}

describe('diffLines', () => {
  it('returns no hunks for identical input', () => {
    expect(diffLines(lines('a\nb\nc'), lines('a\nb\nc'))).toEqual([]);
  });

  it('finds a single replaced line', () => {
    expect(diffLines(lines('a\nb\nc'), lines('a\nB\nc'))).toEqual([{ baseStart: 1, baseEnd: 2, otherStart: 1, otherEnd: 2 }]);
  });

  it('finds pure insertions and deletions', () => {
    expect(diffLines(lines('a\nc'), lines('a\nb\nc'))).toEqual([{ baseStart: 1, baseEnd: 1, otherStart: 1, otherEnd: 2 }]);
    expect(diffLines(lines('a\nb\nc'), lines('a\nc'))).toEqual([{ baseStart: 1, baseEnd: 2, otherStart: 1, otherEnd: 1 }]);
  });

  it('round-trips random edits', () => {
    let seed = 42;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 300; round++) {
      const base = Array.from({ length: Math.floor(random() * 30) }, () => String.fromCharCode(97 + Math.floor(random() * 5)));
      const other = base.flatMap(line => {
        const roll = random();
        if (roll < 0.15) return [];
        if (roll < 0.3) return [line, 'x'];
        if (roll < 0.4) return ['y'];
        return [line];
      });
      expect(applyHunks(base, other)).toEqual(other);
    }
  });
});

describe('merge3', () => {
  const base = lines('one\ntwo\nthree\nfour\nfive');

  it('takes changes from both sides when they do not overlap', () => {
    const result = merge3(base, lines('ONE\ntwo\nthree\nfour\nfive'), lines('one\ntwo\nthree\nfour\nFIVE'));
    expect(result).toEqual({ conflict: false, lines: lines('ONE\ntwo\nthree\nfour\nFIVE') });
  });

  it('accepts identical changes on both sides without conflict', () => {
    const changed = lines('one\nTWO\nthree\nfour\nfive');
    expect(merge3(base, changed, changed)).toEqual({ conflict: false, lines: changed });
  });

  it('marks overlapping different changes as a conflict', () => {
    const result = merge3(base, lines('one\nOURS\nthree\nfour\nfive'), lines('one\nTHEIRS\nthree\nfour\nfive'), { ours: 'remote', theirs: 'mobile' });
    expect(result.conflict).toBe(true);
    expect(result.lines).toEqual(lines('one\n<<<<<<< remote\nOURS\n=======\nTHEIRS\n>>>>>>> mobile\nthree\nfour\nfive'));
  });

  it('merges an append on one side with an edit on the other', () => {
    const result = merge3(base, lines('one\ntwo\nthree\nfour\nfive\nsix'), lines('one\ntwo\nTHREE\nfour\nfive'));
    expect(result).toEqual({ conflict: false, lines: lines('one\ntwo\nTHREE\nfour\nfive\nsix') });
  });

  it('treats an empty base (both sides added the file) as one region', () => {
    const result = merge3([], lines('a\nb'), lines('a\nc'));
    expect(result.conflict).toBe(true);
  });
});
