import {
  commentFirstLine,
  formatInlineComment,
  mergeEmptyContainerTrailing,
  moreBadge,
  moreBadgeAriaLabel,
} from './comment-display';

describe('comment-display', () => {
  describe('formatInlineComment', () => {
    it('returns null for undefined input', () => {
      expect(formatInlineComment(undefined)).toBeNull();
    });

    it('returns null for an empty array', () => {
      expect(formatInlineComment([])).toBeNull();
    });

    it('formats a single body', () => {
      expect(formatInlineComment(['one body'])).toEqual({
        visible: 'one body',
        tooltipBody: 'one body',
        count: 1,
      });
    });

    it('formats two bodies without embedding the badge in the visible text', () => {
      const result = formatInlineComment(['one', 'two']);

      expect(result).toEqual({
        visible: 'one',
        tooltipBody: 'one\ntwo',
        count: 2,
      });
      expect(result?.visible ?? '').not.toMatch(/\(\+\d+\)/);
    });

    it('formats three bodies', () => {
      expect(formatInlineComment(['a', 'b', 'c'])).toEqual({
        visible: 'a',
        tooltipBody: 'a\nb\nc',
        count: 3,
      });
    });

    it('uses only the first line for the visible text of a single multi-line body', () => {
      expect(formatInlineComment(['line 1\nline 2'])).toEqual({
        visible: 'line 1',
        tooltipBody: 'line 1\nline 2',
        count: 1,
      });
    });

    it('preserves embedded newlines inside later bodies in the tooltip text', () => {
      expect(formatInlineComment(['a', 'b\nc'])).toEqual({
        visible: 'a',
        tooltipBody: 'a\nb\nc',
        count: 2,
      });
    });
  });

  describe('commentFirstLine', () => {
    it('returns the substring before the first newline', () => {
      expect(commentFirstLine('multi\nline')).toBe('multi');
    });

    it('returns the full string when no newline is present', () => {
      expect(commentFirstLine('single')).toBe('single');
    });
  });

  describe('moreBadge', () => {
    it('formats a badge for 1 extra comment', () => {
      expect(moreBadge(1)).toMatch(/\(\+1\)/);
    });

    it('includes 9 in the badge text', () => {
      expect(moreBadge(9)).toContain('9');
    });

    it('includes 99 in the badge text', () => {
      expect(moreBadge(99)).toContain('99');
    });
  });

  describe('moreBadgeAriaLabel', () => {
    it('includes 1 in the aria label', () => {
      expect(moreBadgeAriaLabel(1)).toContain('1');
    });

    it('includes 99 in the aria label', () => {
      expect(moreBadgeAriaLabel(99)).toContain('99');
    });
  });

  describe('mergeEmptyContainerTrailing', () => {
    it('returns null for an empty bundle', () => {
      expect(mergeEmptyContainerTrailing({})).toBeNull();
    });

    it('merges trailing before closeLeading', () => {
      expect(
        mergeEmptyContainerTrailing({
          trailing: ['T1'],
          closeLeading: ['c1', 'c2'],
        }),
      ).toEqual({
        visible: 'T1',
        tooltipBody: 'T1\nc1\nc2',
        count: 3,
      });
    });

    it('merges closeLeading before closeTrailing when trailing is absent', () => {
      expect(
        mergeEmptyContainerTrailing({
          closeLeading: ['c'],
          closeTrailing: ['t'],
        }),
      ).toEqual({
        visible: 'c',
        tooltipBody: 'c\nt',
        count: 2,
      });
    });
  });
});
