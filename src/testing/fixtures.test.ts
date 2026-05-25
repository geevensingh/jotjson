import { TestBed } from '@angular/core/testing';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { JsonExtractorService } from '../app/core/json/json-extractor.service';
import { JsonParserService } from '../app/core/json/json-parser.service';
import { PreferencesService } from '../app/core/preferences/preferences.service';
import { JsonTreeComponent } from '../app/shared/components/json-tree/json-tree.component';
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
  'CollapsedContainerSummary.json',
  'Depth.json',
  'EmptyArrayLeaf.json',
  'FlatList.json',
  'IsoDateAnnotations.json',
  'LongNumberValue.json',
  'LongUnbreakableKey.json',
  'LongUnbreakableValue.json',
  'MidKeyMidValue.json',
  'NestedEvents.json',
  'Recursive.json',
  'Semi-valid.json',
  'Simple.json',
  'Test.json',
  'TestHeader.json',
  'Unpretty.json',
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
            `Ensure src/testing/fixtures is registered in angular.json test assets.`,
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
      providers: [provideAnimationsAsync(), ...provideFakeAuth()],
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
        expect(text, 'fixture loaded').toBeDefined();
        const result = svc.parse(text!);
        expect(result.errors, `parse errors for ${name}`).toEqual([]);
        expect(result.ast, `AST for ${name}`).toBeDefined();
        expect(result.value, `parsed value for ${name}`).toBeDefined();
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
        expect(root, `tree root for ${name}`).toBeDefined();
        // A healthy fixture is an object or array at the top level, so the
        // root should have children.
        expect(root?.children, `tree root children for ${name}`).toBeDefined();
        expect(root!.children!.length, `tree root child count for ${name}`).toBeGreaterThan(0);
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
 * extractor returns blockCount === 2; per M7u the surrounding prose is
 * preserved by wrapping the bodies under `json1` / `json2` keys with
 * `prefix` / `between_1_and_2` / `suffix` carrying the request line,
 * inter-body framing, and trailing sentence.
 */
describe('extractor on mixed-text fixtures', () => {
  let mixedText: string;

  beforeAll(async () => {
    const res = await fetch('/fixtures/MultiPartMixedText.json');
    if (!res.ok) {
      throw new Error(
        `Failed to load fixtures/MultiPartMixedText.json: HTTP ${res.status}. ` +
          `Ensure src/testing/fixtures is registered in angular.json test assets.`,
      );
    }
    mixedText = await res.text();
  });

  beforeEach(() => {
    localStorage.removeItem(PREFS_KEY);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideAnimationsAsync(), ...provideFakeAuth()],
    });
  });

  afterEach(() => {
    localStorage.removeItem(PREFS_KEY);
  });

  it('the raw fixture does not parse cleanly as a single JSON document', () => {
    const parser = TestBed.inject(JsonParserService);
    const result = parser.parse(mixedText);
    expect(result.errors.length, 'mixed-text fixture must produce parse errors').toBeGreaterThan(0);
  });

  it('extractFromMixedText finds the two HTTP bodies and wraps them with their surrounding prose', () => {
    const extractor = TestBed.inject(JsonExtractorService);
    const extracted = extractor.extractFromMixedText(mixedText, 2);

    expect(extracted, 'extractor must return non-null on this fixture').not.toBeNull();
    expect(extracted!.blockCount, 'two HTTP bodies in this capture').toBe(2);
    // Multi-block uses JSON.stringify; comments cannot survive the wrapper.
    expect(extracted!.preservesComments).toBe(false);
    // The HTTP-capture fixture has no JSONC comments in either body, so
    // the source-side comment flag should also be false.
    expect(extracted!.hasComments).toBe(false);
    // Surrounding HTTP framing / headers / trailing sentence -> at least
    // one prose segment must survive.
    expect((extracted!.proseSegments ?? 0) >= 1).toBe(true);

    // The wrapped output is a prose-preserving object; parse and inspect
    // the json1 / json2 entries to avoid coupling the assertion to
    // whitespace formatting.
    const wrapper = JSON.parse(extracted!.text) as Record<string, unknown>;
    expect(wrapper['json1']).toEqual(expect.objectContaining({ authentication_data: null }));
    expect(wrapper['json2']).toEqual(expect.objectContaining({ buyer_info: expect.any(Object) }));
    // At least one of prefix / between / suffix must be present.
    const proseKeys = Object.keys(wrapper).filter(
      (k) => k === 'prefix' || k === 'suffix' || k.startsWith('between_'),
    );
    expect(proseKeys.length).toBeGreaterThan(0);
  });
});
