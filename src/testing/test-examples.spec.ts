import { TestBed } from '@angular/core/testing';
import { JsonParserService } from '../app/core/json/json-parser.service';
import { JsonTreeComponent } from '../app/shared/components/json-tree/json-tree.component';
import { PreferencesService } from '../app/core/preferences/preferences.service';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideFakeAuth } from './auth.testing';

/**
 * Integration coverage for the real-world JSON samples under `test-examples/`.
 *
 * For each file, we assert:
 *   1. The parser accepts the raw file text (no errors, AST exists).
 *   2. The JsonTreeComponent renders without throwing given the parsed value.
 *
 * Files are served by the Karma dev server at `/test-examples/<name>` via
 * the assets entry in `angular.json`'s test configuration.
 *
 * The catalogue is a static list so individual specs show up in the Jasmine
 * reporter; adding a new example file requires adding one line here.
 */
const EXAMPLE_FILES = [
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

describe('test-examples fixtures', () => {
  const contents = new Map<string, string>();

  beforeAll(async () => {
    for (const name of EXAMPLE_FILES) {
      const res = await fetch(`/test-examples/${name}`);
      if (!res.ok) {
        throw new Error(
          `Failed to load test-examples/${name}: HTTP ${res.status}. ` +
            `Ensure test-examples is registered in angular.json test assets.`
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

  for (const name of EXAMPLE_FILES) {
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
