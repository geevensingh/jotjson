export interface HighlightPathFixture {
  readonly value: unknown;
  readonly path: string;
}

const unicodeKey = 'caf\u00e9';
const lineBreakKey = 'line\nbreak';
const controlCharacterKey = 'control\u0001char';

function bracketSegment(key: string): string {
  return `[${JSON.stringify(key)}]`;
}

function bracketPath(key: string): string {
  return `$${bracketSegment(key)}`;
}

export const HIGHLIGHT_PATH_FIXTURES: readonly HighlightPathFixture[] = [
  { value: null, path: '$' },
  { value: true, path: '$' },
  { value: 42, path: '$' },
  { value: 'text', path: '$' },
  { value: { foo: { bar: 1 } }, path: '$.foo.bar' },
  { value: { $meta: 1 }, path: '$.$meta' },
  { value: { _private: { value2: 1 } }, path: '$._private.value2' },
  { value: { arr: [10, { child: false }] }, path: '$.arr[1].child' },
  { value: [[{ nested: 'yes' }]], path: '$[0][0].nested' },
  { value: { 'weird key': 1 }, path: bracketPath('weird key') },
  { value: { 'with-dash': 1 }, path: bracketPath('with-dash') },
  { value: { 'with.dot': 1 }, path: bracketPath('with.dot') },
  { value: { 'quote"key': 1 }, path: bracketPath('quote"key') },
  { value: { 'back\\slash': 1 }, path: bracketPath('back\\slash') },
  { value: { [unicodeKey]: 1 }, path: bracketPath(unicodeKey) },
  { value: { '': 1 }, path: bracketPath('') },
  { value: { [lineBreakKey]: 1 }, path: bracketPath(lineBreakKey) },
  { value: { [controlCharacterKey]: 1 }, path: bracketPath(controlCharacterKey) },
  { value: { 'closing]bracket': 1 }, path: bracketPath('closing]bracket') },
  {
    value: { 'a b': [{ 'c.d': { 'quote"': null } }] },
    path: `${bracketPath('a b')}[0]${bracketSegment('c.d')}${bracketSegment('quote"')}`,
  },
] as const;
