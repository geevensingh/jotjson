import { TestBed } from '@angular/core/testing';
import { type Mocked } from 'vitest';
import { BUILD_INFO_TOKEN, type BuildInfo } from '../../../core/build/build-info.token';
import { ClipboardCopyService } from '../../../core/clipboard/clipboard-copy.service';
import { JsonParserService } from '../../../core/json/json-parser.service';
import { StatusBarComponent } from './status-bar.component';

describe('StatusBarComponent', () => {
  let svc: JsonParserService;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [StatusBarComponent] });
    svc = TestBed.inject(JsonParserService);
  });

  function create(
    inputs: Partial<{
      text: string;
      mode: 'json' | 'jsonc';
      parseResult: ReturnType<JsonParserService['parse']>;
      cursor: { line: number; column: number };
    }> = {},
  ) {
    const fixture = TestBed.createComponent(StatusBarComponent);
    if (inputs.text !== undefined) fixture.componentRef.setInput('text', inputs.text);
    if (inputs.mode !== undefined) fixture.componentRef.setInput('mode', inputs.mode);
    if (inputs.parseResult !== undefined)
      fixture.componentRef.setInput('parseResult', inputs.parseResult);
    if (inputs.cursor !== undefined) fixture.componentRef.setInput('cursor', inputs.cursor);
    fixture.detectChanges();
    return fixture;
  }

  function textOf(fixture: ReturnType<typeof create>, selector: string): string {
    const el = fixture.nativeElement.querySelector(selector) as HTMLElement | null;
    return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  }

  function configureWithBuildInfo(
    buildInfo: BuildInfo,
    copySpy?: Mocked<ClipboardCopyService>,
  ): Mocked<ClipboardCopyService> {
    const spy = copySpy ?? ({ copyWithToast: vi.fn() } as unknown as Mocked<ClipboardCopyService>);
    spy.copyWithToast.mockResolvedValue(true);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [StatusBarComponent],
      providers: [
        { provide: BUILD_INFO_TOKEN, useValue: buildInfo },
        { provide: ClipboardCopyService, useValue: spy },
      ],
    });
    return spy;
  }

  function createWithBuildInfo(buildInfo: BuildInfo, copySpy?: Mocked<ClipboardCopyService>) {
    const spy = configureWithBuildInfo(buildInfo, copySpy);
    const fixture = TestBed.createComponent(StatusBarComponent);
    fixture.detectChanges();
    return { fixture, spy };
  }

  it('renders empty defaults', () => {
    const f = create();
    expect(textOf(f, '.left')).toContain('Chars0');
    expect(textOf(f, '.left')).toContain('Lines0');
    expect(textOf(f, '.left')).toContain('Size0 B');
    expect(textOf(f, '.right')).toContain('JSON');
  });

  it('shows text stats for a simple document', () => {
    const text = '{\n  "a": 1\n}';
    const f = create({ text, parseResult: svc.parse(text) });
    const left = textOf(f, '.left');
    // Chars now counts MEANINGFUL characters (whitespace + comments stripped).
    // The minified form of `{\n  "a": 1\n}` is `{"a":1}` = 7 chars.
    expect(left).toContain('Chars7');
    expect(left).toContain('Lines3');
    expect(left).toMatch(/Size\d+ B/);
  });

  describe('meaningful Chars stat', () => {
    it('renders 0 on an empty editor', () => {
      const f = create({ text: '', parseResult: svc.parse('') });
      expect(textOf(f, '.stat-chars')).toContain('Chars0');
    });

    it('shows Chars < Size for pretty-printed JSON', () => {
      const text = '{\n  "a": 1,\n  "b": 2\n}';
      const f = create({ text, parseResult: svc.parse(text) });
      const charsValue = Number(
        f.nativeElement.querySelector('.stat-chars .value')!.textContent!.trim(),
      );
      const bytesValue = Number(
        f.nativeElement.querySelector('.stat-bytes .value')!.textContent!.replace(/[^\d]/g, ''),
      );
      expect(charsValue).toBeLessThan(bytesValue);
    });

    it('shows Chars equal to source length on already-minified ASCII JSON', () => {
      const text = '{"a":1,"b":2}';
      const f = create({ text, parseResult: svc.parse(text) });
      expect(textOf(f, '.stat-chars')).toContain(`Chars${text.length}`);
    });

    it('strips JSONC comments from the Chars count', () => {
      const text = '// header\n{"a":1}';
      const f = create({ text, parseResult: svc.parse(text), mode: 'jsonc' });
      // Stripped form is `{"a":1}` = 7 chars.
      expect(textOf(f, '.stat-chars')).toContain('Chars7');
    });

    it('still renders a numeric Chars count when the document fails to parse', () => {
      const broken = '{"a":}';
      const f = create({ text: broken, parseResult: svc.parse(broken) });
      // Scanner still emits tokens; concrete count is implementation-defined,
      // but it must be a number, not "-".
      const value = f.nativeElement.querySelector('.stat-chars .value')!.textContent!.trim();
      expect(value).toMatch(/^\d+$/);
    });

    it('renders the explanatory tooltip on the Chars span', () => {
      const f = create({ text: '{}', parseResult: svc.parse('{}') });
      const el = f.nativeElement.querySelector('.stat-chars') as HTMLElement | null;
      expect(el?.getAttribute('title')).toBe('Meaningful characters (no whitespace or comments)');
    });

    it('renders the explanatory tooltip on the Size span', () => {
      const f = create({ text: '{}', parseResult: svc.parse('{}') });
      const el = f.nativeElement.querySelector('.stat-bytes') as HTMLElement | null;
      expect(el?.getAttribute('title')).toBe('Bytes if the document was downloaded as-is (UTF-8)');
    });
  });

  it('shows tree stats for a valid document', () => {
    const text = '{"a":[1,2,{"b":true}]}';
    const f = create({ text, parseResult: svc.parse(text) });
    const right = textOf(f, '.right');
    expect(right).toContain('Total Nodes6');
    expect(right).toContain('Max Depth3');
    expect(right).toContain('Objects2');
    expect(right).toContain('Arrays1');
  });

  it('hides tree stats when parse errors exist', () => {
    const broken = '{"a":}';
    const f = create({ text: broken, parseResult: svc.parse(broken) });
    const right = textOf(f, '.right');
    expect(right).toContain('Total Nodes-');
    expect(right).toContain('Max Depth-');
    expect(right).toContain('Objects-');
    expect(right).toContain('Arrays-');
  });

  it('hides tree stats when text is empty', () => {
    const f = create({ text: '', parseResult: svc.parse('') });
    expect(textOf(f, '.right')).toContain('Total Nodes-');
  });

  it('renders explanatory tooltips on each tree-stat span', () => {
    const text = '{"a":1}';
    const f = create({ text, parseResult: svc.parse(text) });
    const titleOf = (selector: string): string =>
      (f.nativeElement.querySelector(selector) as HTMLElement | null)?.getAttribute('title') ?? '';
    expect(titleOf('.stat-nodes')).toBe(
      'Total values in the tree, including objects, arrays, and primitives.',
    );
    expect(titleOf('.stat-depth')).toBe(
      'Maximum nesting depth. The root counts as depth 0; a direct child is depth 1.',
    );
    expect(titleOf('.stat-obj')).toBe('Number of object nodes in the tree.');
    expect(titleOf('.stat-arr')).toBe('Number of array nodes in the tree.');
  });

  describe('Comments stat', () => {
    it('is not rendered when parseResult is undefined', () => {
      const f = create();
      expect(f.nativeElement.querySelector('.stat-comments')).toBeNull();
    });

    it('is not rendered when text is empty', () => {
      const f = create({ text: '', parseResult: svc.parse('') });
      expect(f.nativeElement.querySelector('.stat-comments')).toBeNull();
    });

    it('is not rendered when the document has parse errors, even with comments', () => {
      const broken = '// header\n{"a":}';
      const result = svc.parse(broken);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.commentCount).toBeGreaterThan(0);
      const f = create({ text: broken, parseResult: result });
      expect(f.nativeElement.querySelector('.stat-comments')).toBeNull();
    });

    it('is not rendered when the document parses cleanly but has no comments', () => {
      const text = '{"a":1}';
      const f = create({ text, parseResult: svc.parse(text) });
      expect(f.nativeElement.querySelector('.stat-comments')).toBeNull();
    });

    it('is rendered in JSON mode when comments are present (content-driven, not mode-driven)', () => {
      const text = '// header\n{"a":1}';
      const f = create({ text, parseResult: svc.parse(text), mode: 'json' });
      const el = f.nativeElement.querySelector('.stat-comments') as HTMLElement | null;
      expect(el).not.toBeNull();
      expect(textOf(f, '.stat-comments')).toContain('Comments1');
    });

    it('renders the correct count for mixed multi-line block + stacked line comments', () => {
      // 1 multi-line block + 2 stacked + 1 inline trailing = 4 comments
      const text = '/* multi\n  line */\n' + '{\n  // a\n  // b\n  "x": 1 /* inline */\n}';
      const f = create({ text, parseResult: svc.parse(text), mode: 'jsonc' });
      expect(textOf(f, '.stat-comments')).toContain('Comments4');
    });

    it('renders the explanatory tooltip', () => {
      const text = '// c\n{"a":1}';
      const f = create({ text, parseResult: svc.parse(text), mode: 'jsonc' });
      const el = f.nativeElement.querySelector('.stat-comments') as HTMLElement | null;
      expect(el?.getAttribute('title')).toBe('Number of JSONC comments preserved during parsing.');
    });
  });

  it('shows JSONC badge when mode is jsonc', () => {
    const f = create({ mode: 'jsonc' });
    const mode = f.nativeElement.querySelector('.stat-mode') as HTMLElement;
    expect(mode.classList.contains('mode-jsonc')).toBe(true);
    expect(mode.textContent!.trim()).toBe('JSONC');
  });

  it('renders cursor line/column, defaulting to 1/1 when none provided', () => {
    const f = create();
    const left = textOf(f, '.left');
    expect(left).toContain('Ln1');
    expect(left).toContain('Col1');
  });

  it('reflects explicit cursor values', () => {
    const f = create({ cursor: { line: 12, column: 4 } });
    const left = textOf(f, '.left');
    expect(left).toContain('Ln12');
    expect(left).toContain('Col4');
  });

  describe('build cluster', () => {
    const fullBuildInfo: BuildInfo = {
      version: '0.5.0',
      sha: '0123456789abcdef0123456789abcdef01234567',
      branch: 'main',
      builtAt: '2026-05-01T00:00:00.000Z',
      repoUrl: 'https://github.com/geevensingh/jotjson',
      buildNumber: '234',
    };

    it('renders link with version and short SHA when repo URL is set', () => {
      const { fixture } = createWithBuildInfo(fullBuildInfo);
      const link = fixture.nativeElement.querySelector('.build-link') as HTMLAnchorElement | null;

      expect(link?.textContent?.trim()).toBe('v0.5.0 - 0123456');
    });

    it('links to the GitHub commit URL', () => {
      const { fixture } = createWithBuildInfo(fullBuildInfo);
      const link = fixture.nativeElement.querySelector('.build-link') as HTMLAnchorElement | null;

      expect(link?.getAttribute('href')).toBe(
        'https://github.com/geevensingh/jotjson/commit/0123456789abcdef0123456789abcdef01234567',
      );
      expect(link?.getAttribute('target')).toBe('_blank');
      expect(link?.getAttribute('rel')).toBe('noopener');
    });

    it('copies the full commit SHA when the copy button is clicked', () => {
      const { fixture, spy } = createWithBuildInfo(fullBuildInfo);
      const button = fixture.nativeElement.querySelector('.build-copy') as HTMLButtonElement | null;

      expect(button).not.toBeNull();
      button?.click();

      expect(spy.copyWithToast).toHaveBeenCalledTimes(1);
      expect(spy.copyWithToast.mock.lastCall![0]).toBe(fullBuildInfo.sha);
    });

    it('renders the fallback span for dev builds', () => {
      const { fixture } = createWithBuildInfo({ ...fullBuildInfo, sha: 'dev' });
      const link = fixture.nativeElement.querySelector('.build-link') as HTMLAnchorElement | null;
      const button = fixture.nativeElement.querySelector('.build-copy') as HTMLButtonElement | null;
      const fallback = fixture.nativeElement.querySelector(
        '.stat-build .value.sha',
      ) as HTMLElement | null;

      expect(link).toBeNull();
      expect(button).toBeNull();
      expect(fallback?.textContent?.trim()).toBe('v0.5.0 - dev');
    });

    it('renders the fallback span when the repo URL is empty', () => {
      const { fixture } = createWithBuildInfo({ ...fullBuildInfo, repoUrl: '' });
      const link = fixture.nativeElement.querySelector('.build-link') as HTMLAnchorElement | null;
      const button = fixture.nativeElement.querySelector('.build-copy') as HTMLButtonElement | null;
      const fallback = fixture.nativeElement.querySelector(
        '.stat-build .value.sha',
      ) as HTMLElement | null;

      expect(link).toBeNull();
      expect(button).toBeNull();
      expect(fallback?.textContent?.trim()).toBe('v0.5.0 - 0123456');
    });

    it('omits empty branch parentheses from the build title', () => {
      const { fixture } = createWithBuildInfo({ ...fullBuildInfo, branch: '' });
      const link = fixture.nativeElement.querySelector('.build-link') as HTMLAnchorElement | null;

      expect(link?.getAttribute('title')).toBe(
        'JotJSON v0.5.0 (build 234)\nbuilt 2026-05-01T00:00:00.000Z',
      );
    });

    it('includes (build N) in the tooltip for shipped builds with a known counter', () => {
      const { fixture } = createWithBuildInfo(fullBuildInfo);
      const link = fixture.nativeElement.querySelector('.build-link') as HTMLAnchorElement | null;

      expect(link?.getAttribute('title')).toBe(
        'JotJSON v0.5.0 (build 234) (main)\nbuilt 2026-05-01T00:00:00.000Z',
      );
    });

    it('omits (build N) from the tooltip for dev builds even when the counter is known', () => {
      const { fixture } = createWithBuildInfo({ ...fullBuildInfo, sha: 'dev' });
      const fallback = fixture.nativeElement.querySelector(
        '.stat-build .value.sha',
      ) as HTMLElement | null;

      expect(fallback?.getAttribute('title')).toBe(
        'JotJSON v0.5.0 (main)\nbuilt 2026-05-01T00:00:00.000Z',
      );
    });

    it("omits (build N) from the tooltip when buildNumber is 'unknown'", () => {
      const { fixture } = createWithBuildInfo({ ...fullBuildInfo, buildNumber: 'unknown' });
      const link = fixture.nativeElement.querySelector('.build-link') as HTMLAnchorElement | null;

      expect(link?.getAttribute('title')).toBe(
        'JotJSON v0.5.0 (main)\nbuilt 2026-05-01T00:00:00.000Z',
      );
    });
  });

  describe('M7l narrow viewport collapse', () => {
    const NARROW_THRESHOLD = 768;

    function isNarrow(): boolean {
      return window.innerWidth < NARROW_THRESHOLD;
    }

    function displayOf(fixture: ReturnType<typeof create>, selector: string): string {
      const el = fixture.nativeElement.querySelector(selector) as HTMLElement | null;
      if (!el) return '';
      return window.getComputedStyle(el).display;
    }

    it('hides Chars/Cursor/Nodes/Depth/Obj/Arr/Build at narrow widths', (ctx) => {
      ctx.skip(
        !isNarrow(),
        `Browser iframe width=${window.innerWidth}px is not narrow (< ${NARROW_THRESHOLD}); ` +
          'cannot exercise narrow SCSS media query. Skipping.',
      );
      const text = '{"a":[1,2]}';
      const f = create({ text, parseResult: svc.parse(text) });

      expect(displayOf(f, '.stat-chars')).toBe('none');
      expect(displayOf(f, '.stat-cursor')).toBe('none');
      expect(displayOf(f, '.stat-nodes')).toBe('none');
      expect(displayOf(f, '.stat-depth')).toBe('none');
      expect(displayOf(f, '.stat-obj')).toBe('none');
      expect(displayOf(f, '.stat-arr')).toBe('none');
      expect(displayOf(f, '.stat-build')).toBe('none');
    });

    it('hides Comments at narrow widths when present', (ctx) => {
      ctx.skip(
        !isNarrow(),
        `Browser iframe width=${window.innerWidth}px is not narrow (< ${NARROW_THRESHOLD}); ` +
          'cannot exercise narrow SCSS media query. Skipping.',
      );
      // .stat-comments is conditionally rendered (showComments must be
      // true), so a separate fixture with a JSONC document is needed
      // to put the element in the DOM under SCSS scrutiny.
      const text = '// c\n{"a":1}';
      const f = create({ text, parseResult: svc.parse(text), mode: 'jsonc' });
      expect(displayOf(f, '.stat-comments')).toBe('none');
    });

    it('keeps Lines/Size/Mode visible at narrow widths', (ctx) => {
      ctx.skip(
        !isNarrow(),
        `Browser iframe width=${window.innerWidth}px is not narrow (< ${NARROW_THRESHOLD}); ` +
          'cannot exercise narrow SCSS media query. Skipping.',
      );
      const text = '{"a":[1,2]}';
      const f = create({ text, parseResult: svc.parse(text) });

      expect(displayOf(f, '.stat-lines')).not.toBe('none');
      expect(displayOf(f, '.stat-bytes')).not.toBe('none');
      expect(displayOf(f, '.stat-mode')).not.toBe('none');
    });

    it('does not flex-wrap the surviving stats at narrow widths', (ctx) => {
      ctx.skip(
        !isNarrow(),
        `Browser iframe width=${window.innerWidth}px is not narrow (< ${NARROW_THRESHOLD}); ` +
          'cannot exercise narrow SCSS media query. Skipping.',
      );
      const f = create();
      const left = f.nativeElement.querySelector('.left') as HTMLElement | null;
      const right = f.nativeElement.querySelector('.right') as HTMLElement | null;
      expect(window.getComputedStyle(left!).flexWrap).toBe('nowrap');
      expect(window.getComputedStyle(right!).flexWrap).toBe('nowrap');
    });
  });
});

describe('StatusBarComponent file-backed filename stat (M-PWA write-back Phase 4b)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [StatusBarComponent] });
  });

  function createWithFilename(filename: string | null) {
    const fixture = TestBed.createComponent(StatusBarComponent);
    fixture.componentRef.setInput('filename', filename);
    fixture.detectChanges();
    return fixture;
  }

  it('renders the filename stat when filename input is non-null', () => {
    const fixture = createWithFilename('data.json');
    const stat = fixture.nativeElement.querySelector('.stat-filename');
    expect(stat).not.toBeNull();
    const value = (stat as HTMLElement).querySelector('.value')!;
    expect(value.textContent?.trim()).toBe('data.json');
  });

  it('omits the filename stat when filename input is null', () => {
    const fixture = createWithFilename(null);
    expect(fixture.nativeElement.querySelector('.stat-filename')).toBeNull();
  });

  it('updates the rendered name when the filename input changes', () => {
    const fixture = createWithFilename('a.json');
    expect(
      (
        fixture.nativeElement.querySelector('.stat-filename .value') as HTMLElement
      ).textContent?.trim(),
    ).toBe('a.json');

    fixture.componentRef.setInput('filename', 'b.json');
    fixture.detectChanges();
    expect(
      (
        fixture.nativeElement.querySelector('.stat-filename .value') as HTMLElement
      ).textContent?.trim(),
    ).toBe('b.json');
  });
});
