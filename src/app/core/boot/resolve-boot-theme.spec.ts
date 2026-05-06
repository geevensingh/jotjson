import { resolveBootTheme } from './resolve-boot-theme';

describe('resolveBootTheme', () => {
  it('returns null for a null input (localStorage key missing)', () => {
    expect(resolveBootTheme(null)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(resolveBootTheme('')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(resolveBootTheme('{not json')).toBeNull();
    expect(resolveBootTheme('null')).toBeNull();
    expect(resolveBootTheme('"string"')).toBeNull();
    expect(resolveBootTheme('42')).toBeNull();
  });

  it('returns "dark" for an explicit dark preference', () => {
    expect(resolveBootTheme(JSON.stringify({ theme: 'dark' }))).toBe('dark');
  });

  it('returns "light" for an explicit light preference', () => {
    expect(resolveBootTheme(JSON.stringify({ theme: 'light' }))).toBe('light');
  });

  it('returns null for a "system" preference (media query stays authoritative)', () => {
    expect(resolveBootTheme(JSON.stringify({ theme: 'system' }))).toBeNull();
  });

  it('returns null for unknown theme values', () => {
    expect(resolveBootTheme(JSON.stringify({ theme: 'sepia' }))).toBeNull();
    expect(resolveBootTheme(JSON.stringify({ theme: 42 }))).toBeNull();
    expect(resolveBootTheme(JSON.stringify({ theme: null }))).toBeNull();
  });

  it('returns null when the parsed object has no theme key', () => {
    expect(resolveBootTheme(JSON.stringify({ editorFontSize: 14 }))).toBeNull();
    expect(resolveBootTheme('{}')).toBeNull();
  });

  it('ignores other keys in the parsed object', () => {
    const raw = JSON.stringify({
      theme: 'dark',
      editorFontSize: 18,
      treeFontSize: 13,
    });
    expect(resolveBootTheme(raw)).toBe('dark');
  });
});
