import { TestBed } from '@angular/core/testing';
import { JsonParserService } from '../app/core/json/json-parser.service';
import { JsonExtractorService } from '../app/core/json/json-extractor.service';
import { JsonTreeComponent } from '../app/shared/components/json-tree/json-tree.component';
import { PreferencesService } from '../app/core/preferences/preferences.service';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideFakeAuth } from './auth.testing';

/**
 * Integration coverage for the real-world JSON samples under
 * `src/testing/fixtures/`.
 *
 * For each file, we assert:
 *   1. The parser accepts the raw file text (no errors, AST exists).
 *   2. The JsonTreeComponent renders without throwing given the parsed value.
 *
 * Files are served by the Karma dev server at `/fixtures/<name>` via
 * the assets entry in `angular.json`'s test configuration.
 *
 * The catalogue is a static list so individual specs show up in the Jasmine
 * reporter; adding a new fixture requires adding one line here.
 */
const FIXTURE_FILES = [
  'Bad-Config.json',
  'Depth.json',
  'FlatList.json',
  'NestedEvents.json',
  'Recursive.json',
  'Semi-valid.json',
  'Simple.json',
  'Test.json',
  'TestHeader.json',
  'Unpretty.json'
] as const;

const PREFS_KEY = 'jotjson.preferences.v1';

describe('fixture files', () => {
  const contents = new Map<string, string>();

  beforeAll(async () => {
    for (const name of FIXTURE_FILES) {
      const res = await fetch(`/fixtures/${name}`);
      if (!res.ok) {
        throw new Error(
          `Failed to load fixtures/${name}: HTTP ${res.status}. ` +
            `Ensure src/testing/fixtures is registered in angular.json test assets.`
        );
      }
      contents.set(name, await res.text());
    }
  });

  beforeEach(() => {
    localStorage.removeItem(PREFS_KEY);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [JsonTreeComponent],
      providers: [provideAnimationsAsync(), ...provideFakeAuth()]
    });
  });

  afterEach(() => {
    localStorage.removeItem(PREFS_KEY);
  });

  for (const name of FIXTURE_FILES) {
    describe(name, () => {
      it('parses without errors and exposes an AST', () => {
        const svc = TestBed.inject(JsonParserService);
        const text = contents.get(name);
        expect(text).withContext('fixture loaded').toBeDefined();
        const result = svc.parse(text!);
        expect(result.errors)
          .withContext(`parse errors for ${name}`)
          .toEqual([]);
        expect(result.ast).withContext(`AST for ${name}`).toBeDefined();
        expect(result.value)
          .withContext(`parsed value for ${name}`)
          .toBeDefined();
      });

      it('renders in JsonTreeComponent without throwing', () => {
        const svc = TestBed.inject(JsonParserService);
        const prefs = TestBed.inject(PreferencesService);
        // Force deterministic tree prefs - the component reads these via a
        // computed signal during render.
        prefs.update({ treeShowTypeLabels: true });

        const text = contents.get(name)!;
        const parsed = svc.parse(text);

        const fixture = TestBed.createComponent(JsonTreeComponent);
        fixture.componentRef.setInput('value', parsed.value);
        expect(() => fixture.detectChanges()).not.toThrow();

        const root = fixture.componentInstance.root();
        expect(root).withContext(`tree root for ${name}`).toBeDefined();
        // A healthy fixture is an object or array at the top level, so the
        // root should have children.
        expect(root?.children)
          .withContext(`tree root children for ${name}`)
          .toBeDefined();
        expect(root!.children!.length)
          .withContext(`tree root child count for ${name}`)
          .toBeGreaterThan(0);
      });
    });
  }
});

/**
 * Mixed-text fixtures: prose surrounding one or more JSON bodies. These
 * fixtures intentionally do NOT parse cleanly as a single JSON document
 * (cf. FIXTURE_FILES above which all do). They exercise
 * JsonExtractorService, the M7p extract-from-mixed-text path triggered by
 * paste / native paste / drag-drop / file upload.
 *
 * `MultiPartMixedText.json` is a real-world example: an HTTP request and
 * response capture (two JSON bodies separated by HTTP framing/headers
 * and a trailing free-form sentence). Both bodies parse cleanly so the
 * extractor returns blockCount === 2 and wraps them as an array.
 */
describe('extractor on mixed-text fixtures', () => {
  let mixedText: string;

  beforeAll(async () => {
    const res = await fetch('/fixtures/MultiPartMixedText.json');
    if (!res.ok) {
      throw new Error(
        `Failed to load fixtures/MultiPartMixedText.json: HTTP ${res.status}. ` +
          `Ensure src/testing/fixtures is registered in angular.json test assets.`
      );
    }
    mixedText = await res.text();
  });

  beforeEach(() => {
    localStorage.removeItem(PREFS_KEY);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideAnimationsAsync(), ...provideFakeAuth()]
    });
  });

  afterEach(() => {
    localStorage.removeItem(PREFS_KEY);
  });

  it('the raw fixture does not parse cleanly as a single JSON document', () => {
    const parser = TestBed.inject(JsonParserService);
    const result = parser.parse(mixedText);
    expect(result.errors.length)
      .withContext('mixed-text fixture must produce parse errors')
      .toBeGreaterThan(0);
  });

  it('extractFromMixedText finds the two HTTP bodies and wraps them as an array', () => {
    const extractor = TestBed.inject(JsonExtractorService);
    const extracted = extractor.extractFromMixedText(mixedText);

    expect(extracted)
      .withContext('extractor must return non-null on this fixture')
      .not.toBeNull();
    expect(extracted!.blockCount)
      .withContext('two HTTP bodies in this capture')
      .toBe(2);
    // Multi-block uses JSON.stringify array wrap; comments cannot survive.
    expect(extracted!.preservesComments).toBe(false);
    // The HTTP-capture fixture has no JSONC comments in either body, so
    // the source-side comment flag should also be false.
    expect(extracted!.hasComments).toBe(false);

    // The wrapped output is a JSON array; parse and inspect each element to
    // avoid coupling the assertion to whitespace formatting.
    const value = JSON.parse(extracted!.text) as Array<Record<string, unknown>>;
    expect(Array.isArray(value)).toBe(true);
    expect(value.length).toBe(2);
    expect(value[0]).toEqual(jasmine.objectContaining({ authentication_data: null }));
    expect(value[1]).toEqual(
      jasmine.objectContaining({ buyer_info: jasmine.any(Object) })
    );
  });
});
