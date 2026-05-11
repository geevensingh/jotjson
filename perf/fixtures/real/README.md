# Real-world fixture: `cosmos-doc-sample.json`

This directory holds the single "real-shape" fixture used by the perf
measurement suite. Synthetic fixtures (`deep25`, `wide-aoo`) generated
from `perf/fixtures/generate.ts` cover the extremes; this fixture
covers the messy, irregular shape that real user pastes tend to have:
mixed-depth nesting, heterogeneous arrays, long string values, and a
realistic metadata envelope.

## Provenance

The committed `cosmos-doc-sample.json` is **synthetic**. It was
hand-authored to **resemble** the shape of an Aras Innovator / Cosmos
DB document (the canonical example of JotJSON's user persona) without
being derived from any actual document. No real document content
appears in this file.

If you later want to derive a fixture from an actual private document,
follow the **anonymization recipe** below and run the
`lint:fixture-redaction` helper (see below) before committing.

## Anonymization recipe

When deriving a new fixture from a real document:

1. **All string property VALUES** -> replace with `lorem-<index>`,
   where `<index>` is the lexicographic position of the property
   among string-valued leaves. E.g. the first string value becomes
   `"lorem-0001"`, the second `"lorem-0002"`, and so on.
2. **All UUIDs / GUIDs** (matching
   `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
   -> replace with deterministic placeholders
   `00000000-0000-0000-0000-<12-digit-counter>`.
3. **All timestamps** (ISO 8601 or epoch numeric) -> replace with
   `2000-01-01T00:00:00Z` (string) or `946684800` (epoch seconds).
4. **All email / UPN strings** (matching `@`) -> replace with
   `lorem@example.com`.
5. **Property NAMES** are kept verbatim (they carry shape information,
   not content).
6. **All numeric values OTHER THAN timestamps** are kept verbatim
   (they carry shape information about value ranges, not content).
7. After replacement, run the fixture through `JSON.stringify` (minified)
   then `JSON.parse` round-trip to normalize whitespace and key order.

## Verification

After running the recipe, verify there are no leaks of personal,
organizational, or proprietary data:

```
node scripts/perf/check-fixture-redaction.mjs perf/fixtures/real/cosmos-doc-sample.json
```

The checker flags strings that look like leaked PII or document
content -- real UUIDs (not on the deterministic placeholder pattern),
real emails (anything other than `lorem@example.com`), non-canonical
ISO timestamps, and free-form strings with whitespace or unusual
length. It is permissive on structural tokens that carry shape (not
content): programming identifiers, enum tokens, MIME types, locales,
versions, and `/`-separated paths whose segments are themselves
acceptable.

The check is invoked as a helper when you ADD a derived fixture; it
is NOT part of `lint:all`, so the cost of a false negative on the
checker is bounded by the size of a curated fixture set.

## Why this is in v1

Per the perf plan (`plan.md` "Fixture matrix"), the real fixture is
the **shape coverage** in v1. Variant expansion (with-comments,
with-embedded, large-strings, etc.) is deferred to flame-graph-driven
follow-up issues; we add a variant when the L3 cpuprofile shows a hot
path that the existing shapes don't exercise.
