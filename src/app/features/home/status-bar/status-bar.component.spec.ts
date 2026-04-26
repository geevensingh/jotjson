import { TestBed } from '@angular/core/testing';
import { StatusBarComponent } from './status-bar.component';
import { JsonParserService } from '../../../core/json/json-parser.service';

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
});
