import { __resetColdFlagsForTesting, isColdAndMark } from './cold-flag';

describe('cold-flag', () => {
  beforeEach(() => {
    __resetColdFlagsForTesting();
  });

  it('returns true on the first call for a token', () => {
    expect(isColdAndMark('parse.slow')).toBe(true);
  });

  it('returns false on the second call for the same token', () => {
    isColdAndMark('parse.slow');
    expect(isColdAndMark('parse.slow')).toBe(false);
  });

  it('tracks tokens independently of one another', () => {
    expect(isColdAndMark('parse.slow')).toBe(true);
    expect(isColdAndMark('tree.build.slow')).toBe(true);
    expect(isColdAndMark('tree.render.slow')).toBe(true);
    expect(isColdAndMark('tree.expand.slow')).toBe(true);

    expect(isColdAndMark('parse.slow')).toBe(false);
    expect(isColdAndMark('tree.build.slow')).toBe(false);
    expect(isColdAndMark('tree.render.slow')).toBe(false);
    expect(isColdAndMark('tree.expand.slow')).toBe(false);
  });

  it('reset seam restores cold state for all tokens', () => {
    isColdAndMark('parse.slow');
    isColdAndMark('tree.build.slow');

    __resetColdFlagsForTesting();

    expect(isColdAndMark('parse.slow')).toBe(true);
    expect(isColdAndMark('tree.build.slow')).toBe(true);
  });
});
