import { TestBed } from '@angular/core/testing';
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

  function create(inputs: Partial<{
    text: string;
    mode: 'json' | 'jsonc';
    parseResult: ReturnType<JsonParserService['parse']>;
    cursor: { line: number; column: number };
  }> = {}) {
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
    copySpy?: jasmine.SpyObj<ClipboardCopyService>
  ): jasmine.SpyObj<ClipboardCopyService> {
    const spy =
      copySpy ??
      jasmine.createSpyObj<ClipboardCopyService>('ClipboardCopyService', ['copyWithToast']);
    spy.copyWithToast.and.resolveTo(true);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [StatusBarComponent],
      providers: [
        { provide: BUILD_INFO_TOKEN, useValue: buildInfo },
        { provide: ClipboardCopyService, useValue: spy }
      ]
    });
    return spy;
  }

  function createWithBuildInfo(
    buildInfo: BuildInfo,
    copySpy?: jasmine.SpyObj<ClipboardCopyService>
  ) {
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
    expect(left).toContain(`Chars${text.length}`);
    expect(left).toContain('Lines3');
    expect(left).toMatch(/Size\d+ B/);
  });

  it('shows tree stats for a valid document', () => {
    const text = '{"a":[1,2,{"b":true}]}';
    const f = create({ text, parseResult: svc.parse(text) });
    const right = textOf(f, '.right');
    expect(right).toContain('Nodes6');
    expect(right).toContain('Depth3');
    expect(right).toContain('Obj2');
    expect(right).toContain('Arr1');
  });

  it('hides tree stats when parse errors exist', () => {
    const broken = '{"a":}';
    const f = create({ text: broken, parseResult: svc.parse(broken) });
    const right = textOf(f, '.right');
    expect(right).toContain('Nodes-');
    expect(right).toContain('Depth-');
    expect(right).toContain('Obj-');
    expect(right).toContain('Arr-');
  });

  it('hides tree stats when text is empty', () => {
    const f = create({ text: '', parseResult: svc.parse('') });
    expect(textOf(f, '.right')).toContain('Nodes-');
  });

  it('shows JSONC badge when mode is jsonc', () => {
    const f = create({ mode: 'jsonc' });
    const mode = f.nativeElement.querySelector('.stat-mode') as HTMLElement;
    expect(mode.classList.contains('mode-jsonc')).toBeTrue();
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
      repoUrl: 'https://github.com/geevensingh/jotjson'
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
        'https://github.com/geevensingh/jotjson/commit/0123456789abcdef0123456789abcdef01234567'
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
      expect(spy.copyWithToast.calls.mostRecent().args[0]).toBe(fullBuildInfo.sha);
    });

    it('renders the fallback span for dev builds', () => {
      const { fixture } = createWithBuildInfo({ ...fullBuildInfo, sha: 'dev' });
      const link = fixture.nativeElement.querySelector('.build-link') as HTMLAnchorElement | null;
      const button = fixture.nativeElement.querySelector('.build-copy') as HTMLButtonElement | null;
      const fallback = fixture.nativeElement.querySelector('.stat-build .value.sha') as HTMLElement | null;

      expect(link).toBeNull();
      expect(button).toBeNull();
      expect(fallback?.textContent?.trim()).toBe('v0.5.0 - dev');
    });

    it('renders the fallback span when the repo URL is empty', () => {
      const { fixture } = createWithBuildInfo({ ...fullBuildInfo, repoUrl: '' });
      const link = fixture.nativeElement.querySelector('.build-link') as HTMLAnchorElement | null;
      const button = fixture.nativeElement.querySelector('.build-copy') as HTMLButtonElement | null;
      const fallback = fixture.nativeElement.querySelector('.stat-build .value.sha') as HTMLElement | null;

      expect(link).toBeNull();
      expect(button).toBeNull();
      expect(fallback?.textContent?.trim()).toBe('v0.5.0 - 0123456');
    });

    it('omits empty branch parentheses from the build title', () => {
      const { fixture } = createWithBuildInfo({ ...fullBuildInfo, branch: '' });
      const link = fixture.nativeElement.querySelector('.build-link') as HTMLAnchorElement | null;

      expect(link?.getAttribute('title')).toBe(
        'JotJSON v0.5.0\nbuilt 2026-05-01T00:00:00.000Z'
      );
    });
  });
});
