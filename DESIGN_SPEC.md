# JotJSON - Design Specification

## Overview

**JotJSON** (jotjson.com) is a web application for inputting, storing, and displaying JSON and JSONC (JSON with Comments). Users paste or type raw JSON or JSONC, and the site renders it as an interactive tree view. The app works without an account, but registered users unlock persistent links and submission history.

**Stack:** Angular frontend, Azure hosting (Static Web Apps + related services).

---

## Architecture

### Frontend - Angular SPA

| Layer | Technology |
|---|---|
| Framework | Angular (latest LTS) |
| UI Component Library | Angular Material |
| JSON Tree View | Custom component (recursive tree built on `mat-tree`) |
| State Management | Angular Signals / lightweight service-based state |
| Routing | Angular Router (standalone components, lazy-loaded via `loadComponent`) |
| Auth | MSAL Angular (@azure/msal-angular) for Microsoft Entra External ID |

### Backend - Azure

| Service | Purpose |
|---|---|
| Azure Static Web Apps | Host the Angular SPA (with built-in Azure Functions proxy) |
| Azure Functions (Node/TypeScript) | Serverless API layer |
| Azure Cosmos DB (NoSQL, serverless tier) | Store JSON blobs, user profiles, history |
| Microsoft Entra External ID | Identity provider (email/password + Google social login). Successor to Azure AD B2C (which Microsoft is retiring). |
| Azure CDN / Front Door | *(deferred to post-v1)* - add for WAF and advanced routing if needed. v1 uses Static Web Apps' built-in CDN and custom domain support. |
| Azure Blob Storage | Storage for user avatars and export ZIP artifacts |

### High-Level Diagram

```
Browser (Angular SPA)
  │
  ├── jotjson.com  ──▶  Azure Static Web Apps (built-in CDN, SSL, custom domain)
  │                        │
  │                        ▼
  │                 Angular SPA (static files)
  │
  └── API calls ──▶  Azure Functions (REST API)
                        │
                        ├──▶ Azure Cosmos DB  (blobs, users, history)
                        └──▶ Entra External ID (auth tokens)
```

---

## Domain Model

### Entities

#### JsonBlob
```
{
  id: string (UUID - internal primary key),
  slug: string (NanoID short-id, 6 characters, e.g., "a3Bf9x" - used in public URLs, unique with collision check),
  content: string (raw JSON text),
  title?: string,
  createdAt: DateTime,
  updatedAt: DateTime,
  ownerId: string (every server-persisted blob has an owner; anonymous users keep their JSON only in localStorage),
  isPublic: boolean,
  highlights?: BlobHighlight[] (optional sidecar manual highlights; absent on legacy blobs; max 100 entries; paths unique),
  version: number (monotonic concurrency token; surfaced as the strong ETag and required via If-Match on PUT)
}
```

#### BlobHighlight
```
{
  path: string (canonical JSON tree path; max 1024 characters),
  color: string (literal #RRGGBB hex color),
  cascade: boolean (true means the highlight applies to descendants unless they have their own entry)
}
```

Manual highlight paths use the tree's canonical JSONPath grammar:
root is `$`; valid JavaScript identifier keys use dot notation such as
`$.foo.bar`; other object keys use bracketed JSON string notation such
as `$["weird key"]` or `$["with-dash"]`; array indexes use bracketed
integers such as `$.items[0]`. Equivalent paths must canonicalize to the
same string before write. The server rejects non-canonical paths,
duplicate paths in one blob, paths over 1024 characters, and colors that
are not 6-digit hex.

#### User
```
{
  id: string (Entra External ID object ID / `oid` claim),
  displayName: string,
  email: string,
  avatarUrl?: string,
  createdAt: DateTime,
  plan: "free" (future: "pro"),
  preferences: UserPreferences
}
```

#### UserPreferences
```
{
  theme: "dark" | "light" | "system" (default: "system" - falls back to "dark" when OS preference is unknown),
  editorFontSize: number (default: 14, range: 8-32),
  editorTabSize: number (default: 2, range: 2 | 4),
  defaultTreeExpansionDepth: number (default: 2, range: 1-10),
  treeAutoFitToWindow: boolean (default: true - when true, the JSON tree initially opens at a depth that fits the current viewport using a greedy uniform-depth algorithm with 1.5x overflow tolerance; when false, the tree opens at the fixed depth specified by defaultTreeExpansionDepth (the slider). Migration: existing users whose defaultTreeExpansionDepth equals 2 (the default) get treeAutoFitToWindow = true on first read; users whose defaultTreeExpansionDepth is anything else get false (their customization is preserved)),
  activeRuleSetIds: string[] (default: [] - rule sets currently applied to the JSON view; toggled via the eye/eye-off control on the Formatting Rules listing page and the home-page toolbar chips; persisted server-side so the selection survives across sessions and devices; IDs that no longer resolve to an owned rule set are filtered out on read),
  editorWordWrap: boolean (default: true),
  layoutOrientation: "horizontal" | "vertical" (default: "horizontal" - editor left, tree right; "vertical" = editor top, tree bottom),
  treeFontSize: number (default: 13, range: 8-32),
  treeShowTypeLabels: boolean (default: true),
  treeShowDateAnnotations: boolean (default: true),
  treeShowComments: boolean (default: true - surfaces JSONC line and block comments harvested by the parser as dimmed inline annotations next to their nearest value in the tree view; comments are still tolerated by the parser when this is off, they're just not rendered. The named feature of M7k),
  treeAssumeUtcForIsoDateTime: boolean (default: true - timezone-less ISO 8601 date-time strings are interpreted as UTC instead of local; matches the conventional reading of log timestamps and other machine-emitted ISO values),
  treeAssumeUtcForIsoDateOnly: boolean (default: true - YYYY-MM-DD strings are interpreted as UTC midnight instead of local midnight),
  recentlyViewedEnabled: boolean (default: true - records `viewed` history entries when signed-in users open shared blobs they don't own; controls the `/history` "Recently viewed" timeline),
  searchCaseSensitive: boolean (default: false),
  searchRegexMode: boolean (default: false),
  searchScope: "keys" | "values" | "both" (default: "both"),
  searchValueType: "all" | "date" | "date/time" | "uuid" | "url" | "email" | "path" | "ipv4" | "ipv6" | "integer" | "number" | "string" | "boolean" | "null" | "array" | "object" (default: "all" - when set to a specific type, the tree search restricts candidate nodes to those whose classified value type matches; the existing searchScope rules then decide whether key text and/or value text are eligible for the text match. Empty query + non-"all" lists every node of that type as a navigator),
  blobQuotaStrategy: "auto_fifo" | "manual" (default: "auto_fifo" - delete oldest blob when 100-blob cap reached; "manual" blocks the save with a prompt instead),
  seenBlobQuotaModal: boolean (default: false - flipped to true after the first-time quota explainer modal has been dismissed; synced server-side so the modal doesn't reappear on other devices),
  seenClipboardBanner: boolean (default: false - flipped to true after the first-time paste-permission banner has been dismissed; synced server-side so the banner doesn't reappear on other devices),
  treePathRoot: "jsonpath" | "none" | "root" | "data" (default: "jsonpath" - display prefix used when copying a tree row's path to the clipboard. Internal/canonical pathString always starts with `$`; only the clipboard text is rewritten. `jsonpath` -> `$.foo[0]`; `none` -> `foo[0]` (lodash-style, leading dot stripped); `root` -> `root.foo[0]`; `data` -> `Data.foo[0]` with capital D),
  treeEditorSelectionSync: boolean (default: true - bidirectional tree<->editor selection sync. When on, selecting a tree row reveals the matching range in the editor and moving the editor cursor selects the matching tree row; when off, both panes operate independently. Toggleable from the main toolbar and Profile),
  treeHighlightColors: TreeHighlightColors
}
```

**Intentionally not roamed.** A handful of UI-state values are
persisted per device in `localStorage` rather than as fields on
`UserPreferences`. The most notable is `splitRatio` - the editor
vs. tree pane ratio on `/` - stored under `jotjson.splitRatio.v1`
as a number in `[0.1, 0.9]`. We keep it local-only because:

- It is viewport-dependent. A 70/30 split that feels right on a
  4K monitor is cramped on a 13" laptop, so roaming the same
  number across devices actively hurts UX.
- It couples with `layoutOrientation` (which *is* roamed). One
  scalar can't sensibly serve both horizontal and vertical
  layouts.
- It is transient layout state, closer in spirit to scroll
  position or window size than to declarative preferences like
  theme or tab size.
- It updates on every `pointermove` during a drag, which would
  generate Cosmos write churn even with debouncing.

If we ever decide to roam this, the right shape is
per-orientation (and ideally per-viewport-class) values plus a
multi-second write debounce - not a single number written on
every pointer move.

#### TreeHighlightColors

Stored per-theme: users customize dark-theme and light-theme colors independently so each scheme looks correct on its own background. The app applies `dark` or `light` at runtime based on the active theme (including when `theme = "system"` resolves). Registered users override individual values via color pickers in Profile -> Preferences.

```
{
  dark: ThemeColorSet,
  light: ThemeColorSet
}

ThemeColorSet {
  selectionColor: string,          # primary - the selected row
  matchingValueColor: string,      # secondary - other rows with the same value
  ancestorColor: string,           # parent chain - all ancestors of the selected node
  searchHighlightColor: string,    # search matches - rows matching the search query
  manualHighlightColor: string     # preferred manual-highlight swatch for this theme
}
```

**Default values by theme:**

| Color | Dark theme default | Light theme default |
|---|---|---|
| `selectionColor` | `#264f78` (muted blue) | `#cce4f7` (soft sky blue) |
| `matchingValueColor` | `#3e3d32` (warm gray) | `#fff4cc` (pale amber) |
| `ancestorColor` | `#2a2d2e` (subtle dark) | `#ececec` (subtle light gray) |
| `searchHighlightColor` | `#6a4c00` (muted amber/gold) | `#ffe082` (soft yellow) |
| `manualHighlightColor` | `#7e6500` (muted gold) | `#fff59d` (soft yellow) |

When the user has not overridden a color for a given theme, the app uses that theme's default. Switching themes swaps the active color set; overrides for the inactive theme are preserved. The "Reset to defaults" button in Profile -> Preferences restores the defaults for the **currently active theme only**. `manualHighlightColor` is the per-theme default used for the first, preferred swatch in the manual-highlight flyout; it is user-editable and does not have to match one of the hardcoded palette colors.

#### HistoryEntry

One document per tracked user action. Entries are immutable once
written; the only mutation path is bulk delete via
`DELETE /api/history`.

```
{
  id: string (UUID),
  userId: string (partition key),
  blobId: string (UUID of the subject blob; may no longer resolve if the blob was deleted),
  slug?: string (NanoID slug snapshot at record time, for rendering rows whose blob has since been deleted),
  title?: string (title snapshot at record time, nullable when the blob had no title),
  accessedAt: DateTime,
  action: "viewed"
}
```

In v1 only `"viewed"` events are recorded, written server-side when a
signed-in user opens a shared blob they don't own. Writes are
debounced to one entry per `(user, blob)` per 5 minutes and gated by
the `recentlyViewedEnabled` user preference (default on). Retention:
**1,000 entries per user**, FIFO auto-delete when the cap is
exceeded (symmetric to the 100-blob cap). Legacy rows of other
action types (`saved`/`edited`/`deleted`/`pasted`) written before
the v1 narrowing are filtered out on read and age out via FIFO; see
M5 milestone notes.

#### FormattingRuleSet
```
{
  id: string,
  userId: string,
  name: string,                    # e.g., "Error Highlighter", "API Response Theme"; max 80 chars
  rules: FormattingRule[],         # max 50 entries
  version: number,                 # monotonically incremented on every successful PUT; surfaced as the response ETag and required via `If-Match` on PUT (concurrency control, see §Features 7)
  createdAt: DateTime,             # used for stable sort order in the user's list (precedence order; see §Features 7)
  updatedAt: DateTime
}
```

Storage: one Cosmos document per rule set in the `rule-sets` container
(partition key `/userId`); the `rules` array is embedded so updates to
a set are atomic and reads are single-document. The 50-rule cap (see
§Features 7) keeps every document well below Cosmos's 2 MB item limit.

#### FormattingRule
```ts
type FormattingRule = FormattingRuleSimple | FormattingRulePair;

type FormattingRuleMatchType =
  | 'exact'
  | 'contains'
  | 'starts_with'
  | 'ends_with'; // `regex` deferred to v1.1; see §Features 7

interface FormattingRuleSimple {
  id: string;
  kind?: 'simple'; // Missing legacy kind is read as 'simple'.
  target: 'key' | 'value' | 'key_and_value';
  matchType: FormattingRuleMatchType;
  matchValue: string; // literal to match (e.g., 'error', '200'); max 200 chars
  caseSensitive: boolean;
  style: FormattingStyle;
}

interface FormattingRulePair {
  id: string;
  kind: 'pair';
  keyMatch: KeyMatch;
  valueMatch: ValueMatch;
  style: FormattingStyle;
}

interface KeyMatch {
  matchType: FormattingRuleMatchType;
  matchValue: string; // max 200 chars
  caseSensitive: boolean;
}

type ValueMatch =
  | {
      kind: 'text';
      matchType: FormattingRuleMatchType;
      matchValue: string; // max 200 chars
      caseSensitive: boolean;
    }
  | {
      kind: 'predicate';
      predicate: ValuePredicate;
    };

// First-ship closed set: 18 values. The union is intentionally extensible.
type ValuePredicate =
  | 'is_null'
  | 'is_not_null'
  | 'is_empty'
  | 'is_not_empty'
  | 'has_content'
  | 'lacks_content'
  | 'is_string'
  | 'is_not_string'
  | 'is_number'
  | 'is_not_number'
  | 'is_integer'
  | 'is_not_integer'
  | 'is_boolean'
  | 'is_not_boolean'
  | 'is_object'
  | 'is_not_object'
  | 'is_array'
  | 'is_not_array';

// Deferred format predicates for a follow-up iteration:
// 'is_date', 'is_uuid', 'is_url', 'is_email',
// 'is_ipv4', 'is_ipv6', 'is_path', 'is_date_time'.
```

Legacy top-level fields (`target`, `matchType`, `matchValue`, and
`caseSensitive`) are valid only when `kind` is missing or resolves to
`'simple'`. Pair rules use explicit `keyMatch` and `valueMatch`
sub-objects so they can express a true cross-field AND.

The rule's user-visible label (shown in hover tooltips and the editor's
matched-rule list) is auto-generated from its match config -
e.g. `key contains "error"`, `value exact "200"`, or
`key exact "testHeader" AND value is not null`. Rules have no
human-edited `name` field in v1; this keeps the model and editor
simpler and avoids untranslatable user-supplied strings in the
hover-tooltip flow.

#### FormattingStyle
```
{
  backgroundColor?: string,        # hex color, e.g., "#FFEB3B"
  textColor?: string,              # hex color
  bold?: boolean,
  italic?: boolean,
  underline?: boolean,
  borderColor?: string,            # outline/border highlight color
  icon?: "warning" | "check" | "star" | "info" | "error" | "flag" | "bookmark"  # closed whitelist; new icons require a spec amendment, not user input
}
```

---

## Features & Pages

### 0. App Header (global chrome)

A persistent header (`AppHeaderComponent`) renders at the top of every
authenticated and unauthenticated page. It owns the two globally-consistent
pieces of top-level chrome and exposes a middle slot for page-specific
controls:

- **Brand wordmark** (left) - links to `/` (home).
- **Page content slot** (middle) - feature pages project their own controls
  via `<ng-content>` (e.g., `HomeComponent` wraps its toolbar inside the
  header).
- **Auth cluster** (right):
  - Signed-in: link to `/history` (gated by the `*jjSignedIn` directive),
    user display name linking to `/profile`, and a sign-out affordance on
    `/profile` itself. Anonymous users do not see the `/history` link.
  - Signed-out (auth configured): sign-in button.
  - Auth not configured (env missing): sign-in button rendered disabled
    with an explanatory tooltip so local/dev builds without credentials
    still render a consistent layout.

The header sits above the page's content and owns the divider between
itself and page content (feature-page toolbars must not add a duplicate
bottom border).

### 1. Home / Editor Page  (`/`)

The primary page. Available to **all users** (anonymous + registered).

- **Identity control** (toolbar document state)
  - The home toolbar shows a state pill followed by a document title display.
    It is visible to anonymous and signed-in users and replaces the prior
    signed-in-only title input.
  - Pill states:
    - `Draft` - no blob is loaded (`/`).
    - `Saved` - a blob is loaded and editor content/title match the saved
      version.
    - `Modified` - a blob is loaded and editor content or title differs from
      the saved version.
    - `Saving...` - a save request is in flight.
    - `Sign in to save` - an anonymous user is viewing `/s/:slug`; the pill is
      a clickable call-to-action that starts MSAL sign-in.
  - Dirty model: saved blobs become `Modified` when normalized editor content
    (CRLF and CR collapse to LF before compare) or trimmed title differs from
    the loaded blob. Drafts are never `Modified`; they remain `Draft`.
  - Browser tab title prefixes the normal document title with `*` while the
    saved blob is `Modified`.
  - Save button: for owners, disable Save when `loadedBlob !== null &&
    !dirty()` so unchanged blobs do not issue server PUTs. For signed-in
    non-owners, keep Save enabled whenever there is content and label it
    `Save as copy`; saving forks to a new blob (see Persistent Link / Share
    for fork-on-save semantics).
  - Anonymous users on `/s/:slug` can edit the shared blob in the editor.
    These edits are local-only, are not auto-persisted to the global draft,
    and are lost on hard refresh.
  - When an anonymous user clicks `Sign in to save`, snapshot `{ slug,
    content, title }` to `sessionStorage` under `jotjson.signInRestore.v1`
    before the MSAL redirect. After sign-in returns, restore the snapshot only
    if the user lands back on the same `/s/:slug`, then clear it.
  - On narrow viewports, hide the title text but keep the pill visible. The
    `Sign in to save` label compacts to `Sign in`.
  - The pill lives in an `aria-live="polite"` region so screen readers announce
    state changes.
  - **Title suggestions** (M7r): when signed in, a small wand icon button sits
    between the title input and the state pill. It is enabled whenever the
    editor has non-empty content (the user can also click it to look for a
    better title than they typed -- picking a candidate replaces whatever is
    in the title input). Clicking it opens a
    menu of 2-7 candidate titles inferred from the current document. Picking
    a candidate writes it into the title input. The candidates are computed
    **lazily on click** (not per keystroke) by composing a registry of pure
    strategy functions in `core/title-suggester/` -- ordered by confidence
    and deduplicated case-insensitively -- against the already-memoized
    parsed value plus the most recent uploaded/dropped file's name (cleared
    on paste, manual clear, blob load, blob delete, and sign-in restore;
    preserved across format/minify/title-edit). Strategies cover known
    formats (`package.json`, Kubernetes manifests, OpenAPI / Swagger, JSON
    Schema, GeoJSON, ARM templates, `tsconfig`, GitHub Actions workflows,
    Postman collections), HAL `_links.self.href` and `selfUrl` / `self_url`,
    common identifier fields (`name > title > displayName > subject > label
    > id > slug`, with UUID/numeric/long values rejected for `id`/`slug`),
    type discriminators (`@type`, `__typename`, `resourceType`), top-level
    keys, the first sentence of `description`/`summary`, generic shape
    descriptions (`Object with N keys`, `List of N items`, `Number {value}`,
    etc.), the first 40 characters of the raw text, and a final `Untitled`
    fallback. A post-dedupe synthetic floor (`Untitled - YYYY-MM-DD` then
    `Untitled (n)`) guarantees at least 2 menu items so the button is
    never useful-but-empty. **Privacy:** acceptance fires the
    `toolbar.titleSuggestionAccepted` telemetry event with the strategy
    `source` and the menu's candidate count -- the candidate's literal text
    is never logged. Hidden on narrow viewports alongside the title input.

- **JSON Input Panel** (left or top, depending on layout preference)
  - Monaco Editor for syntax highlighting, line numbers, error markers, and JSON/JSONC-specific IntelliSense. Loaded lazily to offset its ~2 MB bundle size. The editor and parser unconditionally accept comments and trailing commas; an editor "mode" tag (`json` vs `jsonc`) is auto-derived from content (presence of `//` or `/* */` comments) purely to drive the status-bar badge label and the download filename extension. There is no manual mode switch - mode reflects the document, not user choice.
  - **JSONC support**: the editor and parser accept JSON with Comments (single-line `//` and multi-line `/* */`), as well as trailing commas. Comments are stripped before parsing into the tree view but preserved in the raw editor text. When saving a blob, the original text (with comments) is stored; the parsed tree is derived on load. This uses a JSONC-aware parser (e.g., `jsonc-parser` from the VS Code ecosystem) rather than native `JSON.parse`.
  - "Paste JSON from Clipboard", "Upload File", "Download as File", "Clear", "Format / Pretty-Print", and "Minify" action buttons.
  - Real-time JSON validation with inline error messages (line + column of parse error).
  - **Smart Paste Button** behavior:
    - On page load (and periodically while the page is focused), the app reads the clipboard using the **Clipboard API** (`navigator.clipboard.readText()`).
    - The browser will prompt the user for clipboard permission on first access. The app requests this permission early via a clear banner prompt (e.g., "Allow clipboard access to enable one-click paste") shown on first page load. If the user denies permission, the button is **disabled** with a tooltip explaining that clipboard access is blocked and that standard `Ctrl+V` paste still works normally.
    - The clipboard contents are tested with a lightweight parse attempt (JSONC-aware parser). If the text is valid JSON or JSONC (or starts with `{` or `[` and is plausibly JSON), the **"Paste JSON from Clipboard"** button is **enabled** with a green/active state and a tooltip showing a preview of the first ~80 characters.
    - If the clipboard does not contain JSON-like text, the button is **disabled/grayed out** with a tooltip: "Clipboard does not contain JSON".
    - Clicking the enabled button replaces the editor contents with the clipboard JSON and triggers the tree view to render.
    - The clipboard check runs: (1) on page/tab focus, (2) when the user clicks into the editor panel, and (3) on a short polling interval (~2 seconds) while the page is visible. Polling stops when the tab is backgrounded (using `document.visibilityState`).
    - **Fallback for restricted browsers:** if the browser denies clipboard polling (some require a user gesture), the button remains always visible in an "unknown" state. Clicking it triggers a user-gesture clipboard read - if the content is valid JSON, it pastes immediately; if not, a brief tooltip says "Clipboard does not contain JSON". This ensures the feature works even without polling permission.
    - **Privacy note:** clipboard contents are never sent to the server - the check is entirely client-side.
    - **Auto-unescape on paste** (toolbar Paste button and native Ctrl+V): if the pasted text is not already valid JSON/JSONC at the top level (object or array), the app attempts a best-effort unescape to recover JSON that was stringified or copied out of a log/debugger - e.g. `{\"a\":1}` becomes `{"a":1}`. A recovered payload is accepted only when it parses cleanly and yields an object or array; ordinary prose containing `\n` or stray backslashes is left alone. For toolbar paste the recovered payload is also auto-formatted. For native paste inside the Monaco editor, the unescape is applied only when the hypothetical post-paste buffer also parses cleanly, to avoid mangling a legitimate escaped string value being pasted into an existing document. Undo (Ctrl+Z) reverts to the raw paste.
    - **Copy as escaped JSON string**: holding Alt while invoking a copy action writes `JSON.stringify(textBeingCopied)` to the clipboard - the JSON-string-literal variant of the same content - so the value can be embedded as a string in another JSON document. This is the inverse of auto-unescape on paste. Supported entry points: the toolbar Copy button (Alt+click), double-clicking a primitive tree row (Alt+double-click copies the row's value escaped; Alt is ignored on container rows since their dblclick toggles expansion - see issue #109), and the row's right-click "Copy value" context-menu item (Alt+click on the menu item; this remains the way to copy a container's serialized form). All other copy actions (Copy key, Copy path, breadcrumb copy-path, share link, blob URL, build SHA) do not honor Alt.
    - **Extract JSON from mixed text** (toolbar Paste and native Ctrl+V): if a paste does not parse as JSON/JSONC even after auto-unescape, the app scans the pasted text for embedded object/array literals (e.g., a `curl -v` transcript, a log line, or prose wrapping a payload). When one or more candidates are found, a non-destructive banner appears above the editor offering `[Extract JSON]` / `[Dismiss]`; the editor still contains the raw paste so users can decline. A single embedded block is extracted via `jsonc-parser` `format()` so comments are preserved; multiple blocks are wrapped as a JSON array via `JSON.stringify` (comments are lost across the array boundary - the banner says so). Primitives (numbers, strings, booleans, null) are not extracted. Inputs above 1 MB are skipped for performance. The banner auto-clears as soon as the editor content changes again (typing or another paste).
  - **File Upload** - two ways to load a JSON file:
    - **Toolbar button** ("Upload File"): opens a native file picker filtered to `.json`, `.jsonc`, `.jsonl`, `.geojson`, and `.txt` extensions. Reads the selected file client-side via the `FileReader` API and loads its contents into the editor.
    - **Drag & drop**: users can drag a file from their desktop onto **any part of the page**. A full-page drop zone overlay appears with a visual cue (dashed border + "Drop JSON file here" message) when a file is dragged over the window. On drop, the file is read and loaded into the editor. If the user drops **multiple files**, the drop is rejected entirely with an error toast: "Please drop one file at a time."
    - **Validation**: after reading, the file contents are parsed with the JSONC-aware parser. If invalid, the raw text is still loaded into the editor but the validation error banner appears (same as manual input errors). The validation list is the same surface used for typed errors (per "Validation error inline" below); the upload also surfaces a dismissible upload-source banner above the editor that auto-clears on the next clean parse, so users can distinguish upload failures from typing errors. When the JSON extractor offers an embedded block (M7p), the extract banner takes precedence and the upload-source banner is suppressed - the extract banner is the more actionable surface and showing both is redundant. If the file contains comments, the editor automatically switches to JSONC mode.
    - **Binary rejection**: before parsing, files that do not appear to be text (detected via known binary magic bytes, embedded NUL characters after decode, or a high ratio of non-printable code points) are rejected with a toast and the editor is left unchanged. UTF-8 (with or without BOM) and UTF-16 LE/BE files (with BOM) are decoded as text; other encodings are not supported.
    - **Size limit**: files up to **5 MB** are accepted client-side. Larger files show a toast: "File too large - max 5 MB". (Server-side save limit remains 1 MB for persisted blobs.)
    - Uploading replaces the editor contents immediately - **no confirmation prompt** even when the editor already has content. Users can recover their prior content via the editor's built-in undo (Ctrl+Z) if needed.
    - The file name is shown in a subtle label near the editor (e.g., "Loaded: config.json") until the content is manually edited.
    - **Privacy note:** file contents are read entirely client-side and never uploaded to the server unless the user explicitly saves the blob.
  - **Download as File** - a toolbar button saves the current editor content as a file to the user's device. Uses a client-side `Blob` + anchor `download` attribute - no server involvement. Default filename is the blob's title (slugified) or `jotjson-<slug>.json` for a saved blob, or `jotjson-untitled.json` for unsaved editor content. Extension is `.jsonc` when the editor content contains comments (the auto-derived JSONC mode), otherwise `.json`. Available to all users (anonymous + registered).

- **Tree View Panel** (right or bottom, depending on layout preference)
  - Renders the parsed JSON as a collapsible, interactive tree.
  - **Empty containers** render inline on a single row: empty arrays as `[]` with a `0 items` annotation, empty objects as `{}` with a `0 keys` annotation, using the same container glyph styling as non-empty containers so that an empty structure is visually distinct from a missing value.
  - Each row layout: `[expand/collapse icon]  key: value  ................  [type label]`
  - **Type labels** - right-aligned on every row, showing the richest known descriptor for the value:
    - `string` - string values that don't match a more specific classifier.
    - `number` - numeric values with a fractional part.
    - `integer` - numeric values that are whole numbers.
    - `boolean` - true/false values.
    - `null` - null values.
    - `array:N` - arrays, where N is the number of direct items (e.g., `array:5`).
    - `json:X` - objects, where X is the total number of nodes in the subtree rooted at that object (recursive count of all descendant keys). E.g., a nested object containing 3 keys, one of which is itself an object with 2 keys, displays `json:5`.
    - String values are additionally classified into more specific labels when the content matches: `date` and `date/time` (parseable ISO 8601, RFC 2822, or slash-form date - gated by `treeShowDateAnnotations` so the badge stays in sync with the annotation visibility), `uuid`, `url`, `email`, `path` (URL-style absolute or relative paths, e.g., `/api/v2/items` or `docs/intro.md` - excludes full URLs with scheme), `ipv4`, `ipv6`. Detection is conservative; ambiguous strings fall back to `string`.
  - Type labels are styled with a muted/subdued color and a small sans-serif font so they don't compete with the key/value content. Type labels use a single muted color rather than per-type coloring - leaf values themselves already carry semantic color (strings, numbers, booleans, null), so coloring the type badge too would be visual noise. Per the **decoration vs data font** rule below, the badge - like every other JotJSON-added annotation in the tree - renders in the UI sans-serif face rather than the document's monospace face.
  - Type labels can be toggled on/off via the "Show type labels" preference in user settings.
  - **Decoration vs data fonts.** The tree mixes two type families on every row, and the rule for which to use is uniform: **anything inside the user's JSON document renders in the document's monospace face; anything JotJSON adds *about* the document renders in the UI sans-serif face, italic and dimmed.**
    - **Monospace (data):** keys, indexes, primitive values (strings, numbers, booleans, null), and structural brace glyphs (`{`, `}`, `[`, `]`, and the `{ ... }` / `[ ... ]` collapsed-container shorthand).
    - **Sans-serif italic dimmed (decoration):** type-badge labels (`[number]`, `[string]`, ...), container-count annotations (`3 items`, `2 keys`), date/time annotations (`(Nov 5, 2024 - 1 year ago)`), and JSONC comment slots (leading and trailing). Anything new the tree adds about a row defaults to this lane.
    - The rule reinforces a clean mental model when scanning a row: monospace = your JSON; proportional italic dimmed = our annotation about it.
  - **Expansion controls** (toolbar above the tree):
    - **Collapse All** button - collapses every node in the tree.
    - **Expand All** button - expands every node in the tree.
    - **Expand to Level** - a dropdown (values 1-10) that expands nodes down to the chosen depth and collapses everything deeper. E.g., "Level 2" expands the root and its immediate children but collapses grandchildren.
    - The current expansion level is displayed and persists across re-renders of the same blob.
    - Keyboard shortcuts: `Ctrl+Shift+[` (collapse all), `Ctrl+Shift+]` (expand all), `Alt+1` through `Alt+9` (expand to level N - uses Alt to avoid conflicting with browser tab shortcuts).
  - **Auto-fit on initial render.** When `treeAutoFitToWindow` is on, the tree picks an initial expansion depth K such that the rows visible at that depth fill the viewport without overflowing badly. The chosen K is the largest depth where `sum(nodes_at[0..K]) <= 1.5 * viewport_capacity`, with a floor of K = 0 (root collapsed) for very wide documents. Auto-fit fires only when the underlying parsed JSON value changes; it does NOT re-fire on viewport resize, on search state changes, or on rule-set styling changes in the rule editor's live preview. The user's expand/collapse interactions after auto-fit are sticky.
  - **Selection breadcrumb**- a single-line breadcrumb sits between the expansion controls and the tree, showing the path from the root to the currently-selected row as chevron-separated chips (e.g., `Root > users > [0] > name`). The chips are clickable buttons; clicking one re-selects that node (which expands the path and scrolls it into view via the same `selectByPathString` flow as editor->tree sync). The first chip is always the literal label `Root` (decoupled from `treePathRoot` clipboard formatting - this is navigation, not paste output) and points at `$`. The currently-selected node is the **last** chip and is rendered with `aria-current="location"` and the same selected-row highlight (`var(--highlight-selection)`) used in the tree, so the bar always shows the full path to the current selection; clicking the current chip is a deliberate no-op (the selection is already there) but still emits its telemetry event. With no selection, the breadcrumb shows a muted `No current selection` placeholder (`aria-live="polite"`) so the slot does not look empty. Truncation is **width-driven**: chips render at their natural width and only collapse when the row would otherwise overflow its container - middle chips are progressively popped into an overflow chip (`...`) that opens a `mat-menu` listing the hidden chips in tree order. The first and last chips are always kept visible; individual chips can ellipsize as a final safety net for one extremely long key. Each chip click emits a `tree.breadcrumb.click` info-level event with `{depth, selectionUpDistance}`: `depth` is the 0-based root-down index of the clicked chip and `selectionUpDistance` is `(crumbs.length - 1) - depth` - i.e., how many levels up from the current selection the click was (0 means clicking the current chip itself, larger numbers mean jumping further toward the root). The canonical path string (which may contain user content) is **not** logged. A trailing **Copy JSON path** button lives at the right edge of the breadcrumb bar; it copies the selected row's path using the user's `treePathRoot` preference (the same writer used by the per-row context menu's Copy path) and emits `tree.breadcrumb.copyPath` with `{depth: crumbs.length - 1, selectionUpDistance: 0}`. The button is disabled when nothing is selected. The breadcrumb is visible in `embeddedMode` (e.g., the rule-editor live preview) for orientation.
  - Click-to-copy path (e.g., `$.users[0].name`). Available via the per-row context menu's **Copy path** action. The root prefix is configurable per user via `treePathRoot` (default `$`; also `none` for lodash-style `users[0].name`, `root.users[0].name`, or `Data.users[0].name`).
  - **Smart date/time detection** - when a string value is parseable as a date/time, the tree displays:
    - The raw original string as-is (e.g., `"2024-11-05T18:30:00Z"`).
    - Followed by a parenthetical annotation showing: the parsed date/time in the user's local format and an approximate relative time.
    - Example: `"2024-11-05T18:30:00Z"  (Nov 5, 2024, 11:30 AM PST - 1 year ago)`
    - The annotation is styled in a muted/italic font to distinguish it from the raw value.
    - Detection heuristics: ISO 8601, RFC 2822, and common formats like `YYYY-MM-DD`, `MM/DD/YYYY`. Uses a conservative parser - ambiguous strings (e.g., `"12345"`, `"hello"`) are not treated as dates. Numeric values (e.g., Unix timestamps) are **not** annotated - only string values are eligible.
    - Relative time updates live (e.g., "3 minutes ago" -> "4 minutes ago") while the page is open.
    - This feature can be toggled on/off via a tree toolbar toggle or the `treeShowDateAnnotations` user preference.
    - Two related preferences (`treeAssumeUtcForIsoDateTime`, `treeAssumeUtcForIsoDateOnly`, both default `true`) control whether ISO 8601 strings without an explicit timezone designator are interpreted as UTC. Defaults match the conventional reading of machine-emitted timestamps (logs, .NET round-trips, etc.); turn off either setting to fall back to native `Date` semantics (date-time as local, date-only as local midnight). The displayed absolute date is always in the user's local timezone via `Intl.DateTimeFormat` - these settings only change what instant the source string represents.
  - **JSONC comment surfacing.** When the input is JSONC (line `//` or block `/* */` comments), the parser harvests every comment in a second pass and attaches it to the nearest tree node. Comments render as dimmed inline annotations on the same row as the value they document - a *trailing* slot when the comment sits on the same source line as the value's end-token (or on the same line as a container's close brace), a *leading* slot before the next value when the comment introduces it. Comment-only or empty containers carry their internal comment on the close row. The slot is single-line + ellipsis; the full text (including multi-line block comments) is exposed via tooltip. Comments do not participate in formatting-rules matching or in tree search. Toggleable via the `treeShowComments` user preference (default true); turning it off hides the slots without re-parsing.
  - **Extract embedded JSON from string leaves.** After a clean parse settles, the Home page waits 1000 ms, walks the parsed tree for string leaves, and sends the unique strings through a Web Worker-backed scanner. The scanner pre-screens for object/array delimiters, batches work in chunks of 50, and keeps a 10000-entry LRU cache so repeated values do not rescan. Rows whose raw string value contains extractable embedded JSON show a small extract pill and a matching context-menu item. Clicking either affordance splices the extractor's formatted JSONC text over only the selected value token using `jsonc-parser` node offsets and `applyEdits`; comments outside the target value and comments inside the extracted payload are preserved literally. Source-version tokens drop stale clicks after the tree changes, and telemetry records only counts/source enums - never string values or paths.
    M7t adds prose-preserving wrapper output: when embedded JSON in a string is surrounded by non-JSON text, clicking extract replaces the string value with an object that preserves both. A single JSON block appears under `json`, and prefix/suffix prose is stored under `prefix` and `suffix`; for multiple JSON blocks the values use `json1`, `json2`, etc., with inter-block text under `between_<i>_and_<j>` keys. Segments containing only whitespace after trim are omitted from the wrapper. This differs from the simple case: a single JSON block with no surrounding text still produces a bare value. See milestone M7t.
  - **Decoded view toggle on string leaves.** String values whose JSON-escaped form is hard to read at a glance (anything containing a newline, carriage return, tab, embedded `"`, or `\`) get a second small pill next to the Extract pill, plus a matching context-menu item. Toggling the pill flips the row's value rendering between the canonical JSON-escaped single-line form (`"first\nsecond"`) and the decoded multi-line form (`first` / `second` on separate lines, with `pre-wrap` so embedded tabs and quotes render literally). The toggle is purely a display affordance: it does NOT mutate the underlying value, change copy semantics (Copy still yields the raw string), affect tree search (which always matches the JSON-escaped form so escape sequences in the query stay literal), or persist anywhere. State is per-row, in-memory, and cleared whenever the active blob changes; toggling Format/Minify is treated as a non-resetting reparse and preserves the user's per-row state. Each click logs `tree.decoded.click` with `source` (`rowButton` / `contextMenu`), `direction` (`on` / `off`), and a `lineCountBucket` enum - never the string contents.
  - **Selection highlighting** - clicking a row in the tree activates three highlight layers (colors below reference the active theme's values from `TreeHighlightColors`):
    - **Selected row** - highlighted in the user's **primary selection color**. Only one row is selected at a time.
    - **Matching value rows** - all other rows whose value is identical to the selected row's value are highlighted in the **secondary color**. Matching compares the raw JSON value (type-aware: `"1"` != `1`). A small badge icon appears on each matching row to make them easy to spot.
    - **Ancestor rows** - every parent node from the selected row up to the root is highlighted in the **ancestor color**, making it easy to see the path/context of the selection.
    - Theme-appropriate defaults are defined in the `TreeHighlightColors` section of the Domain Model.
    - Registered users can override each color individually (per theme) in the **Profile -> Preferences** section via color pickers.
    - Selection remains active until `Escape` is pressed or the underlying JSON value changes; selecting another row moves the highlights to that row.
  - **Tree<->editor selection sync** - when enabled (default), selecting a tree row reveals the matching range in the editor (scrolled into view if off-screen, focus stays on the tree) and moving the editor cursor selects the matching tree row. For primitive leaves, array elements, and top-level containers the highlight covers just the value token; for object/array values inside a property the highlight covers the whole `"key": <value>` block. A cursor outside any structural node (trailing whitespace, before the document starts, no parsed AST) clears the tree selection. The behavior is controlled by the `treeEditorSelectionSync` user preference (default `true`); both directions are gated by a single toggle exposed as a toolbar button (arrows-exchange / arrows-exchange-off icon) and as a matching slide toggle in Profile. When disabled, both panes operate independently - prior selections stay visible but stop driving each other; toggling back on does not force a resync, the next user gesture re-engages.
  - **Per-row context menu** - right-click on any tree row, or click the row's kebab button (always visible at the right edge, low-contrast styling that brightens on hover), opens a single shared menu of row-level actions. Items adapt to the row's kind and the current expansion state, and are hidden when not applicable:
    - **Copy key** - copies the row's key (object member name or array index). Hidden on the root.
    - **Copy value** - copies the row's value: raw text for `string`, stringified for `number`/`boolean`, the literal `null` for null, and pretty-printed (2-space, multi-line) JSON for objects/arrays.
    - **Copy path** - copies the row's path; respects `treePathRoot`.
    - **Search by key** - sets the search to the key text, scope to `keys`, regex mode off, and the value-type filter to `all`. The clicked row becomes the active hit when present in the result set.
    - **Search by value** - same wiring, scope `values`. Hidden on `null` and on container rows. Both search items are also hidden in `embeddedMode` (the rule-editor live preview has no search bar).
    - **Collapse** - hides itself when the row is already collapsed.
    - **Isolate** / **Collapse siblings** - smart-visibility action(s) that fold the tree to focus on the clicked branch. Both leave the ancestor chain (root..clicked row) and the clicked row's own subtree expansion state untouched. Define `narrowSet` = visibly-expanded peers under the clicked row's immediate parent; `widerSet` = visibly-expanded peers at every higher ancestor (grandparent up to root). **Isolate** collapses `narrowSet U widerSet`; **Collapse siblings** collapses `narrowSet` only. Hidden expanded state under newly-collapsed off-chain branches is preserved (standard CDK FlatTree behavior). Visibility (when the clicked row resolves to a current, non-root node): show neither when both sets are empty; show single **Isolate** when `widerSet` is empty (wide and narrow produce identical end states) or when `narrowSet` is empty (narrow would be a no-op and wide is the only meaningful action); show **both Collapse siblings and Isolate** only when both sets are non-empty (the two actions produce distinct end states). Right-clicking the root row never offers Isolate items, and the actions are no-ops if the path no longer resolves in the current model.
    - **Expand all from here** - hides itself when every container in the subtree is already expanded.
    - **Expand to depth +1..+5 from here** - **expand-only** semantics: each container in the subtree at relative depth `< N` is expanded if it is currently collapsed, and nothing is ever collapsed (the action is purely additive and idempotent). An entry is shown only when (a) `N` does not exceed the deepest descendant's relative depth from the clicked node, and (b) at least one container at relative depth `< N` somewhere in the subtree (including hidden under a collapsed ancestor) is currently collapsed - i.e., the action would actually expand something. Together these hide redundant entries deeper than the subtree (`+4`/`+5` on a 3-level subtree) and entries that have nothing left to do (everything `+1..+N` on a fully-expanded subtree). Trade-off: there is no per-row "collapse to depth +N" - to reset a partially-expanded subtree the user invokes **Collapse** then re-expands. The toolbar's global **Expand to Level** dropdown still uses snap-to-exact semantics across the whole tree; only the per-row context menu is expand-only.
    - The right-click flow positions the menu at the cursor; the kebab self-anchors at its own location. Re-right-clicking a different row while the menu is open repositions it. Keyboard-fired contextmenu (`clientX/Y === 0`) is ignored in v1; full keyboard support is a follow-up. Each invoked action emits an info-level telemetry event under `tree.contextMenu.*`; no user content is logged.
  - **Manual highlights** - owners can persist row-background marks on saved blobs so recipients can see the author's focus.
    - The per-row context menu (right-click or kebab) adds, in order:
      **Highlight**, **Highlight tree**, **Remove highlight**, and
      **Remove tree highlight**. Highlight actions open an 11-swatch
      flyout: the user's preferred `manualHighlightColor` first,
      visually marked, then 10 hardcoded palette colors for the
      active theme. Choosing a swatch paints the row with that literal
      hex color.
    - `Highlight` stores or replaces one `BlobHighlight` at the row's
      canonical path with `cascade: false`. `Highlight tree` stores or
      replaces one entry at the row's canonical path, with `cascade: true`,
      and resolves it at render time for all descendants. A child's own entry
      always beats an inherited ancestor cascade. Array order is not
      meaningful; paths are unique.
    - `Remove highlight` is visible only when the row owns a non-cascade
      manual highlight, and removes that entry. `Remove tree highlight`
      is visible whenever any cascade entry exists on the row's self-or-
      ancestor chain, even if a nearer non-cascade entry is currently
      painting the row; it removes the nearest cascade entry.
    - Tree-highlight availability is gated by JSON type in the UI.
      Object and array rows, including empty containers, show both
      Highlight and Highlight tree. Primitive rows show only Highlight.
      Closing-brace rows have no independent path, so they show only
      the tree-scope actions, retargeted to the matching opener's path
      (the parent container's path). The server validates shape and path
      grammar but does not enforce this type gate.
    - Manual highlights are stored as `JsonBlob.highlights?:
      BlobHighlight[]`, a sidecar on the blob. They are edited in
      memory until save; `POST /api/blobs` and `PUT /api/blobs/:id`
      carry them with the other blob fields. Read-only viewers
      (anonymous public/unlisted readers and signed-in non-owners) see
      existing highlights but cannot add, change, or remove them.
      Fork-on-save copies the source blob's highlights into the new
      owner-owned blob.
    - The renderer keeps provenance for the winning manual highlight:
      color, source path, whether it was a cascade, and whether it was
      inherited. This drives cascade-removal ARIA text and ensures the
      nearest cascade can be removed even when it is not the visible
      winning color.
    - Highlight colors are stored as literal `#RRGGBB` hex, not theme
      tokens. This preserves exact same-color fidelity for recipients
      but is a v1 contrast tradeoff: if an author in dark mode picks
      `#7e6500` and shares with a friend in light mode, the friend still
      sees `#7e6500` on a light background, which may have poor
      contrast.
    - Stale paths are kept in storage and render as nothing when they no
      longer resolve. On successful save, the client prunes
      unresolvable paths only when the current content parses cleanly;
      if content is syntactically invalid, pruning is skipped and all
      stored highlights ride through unchanged.
    - Accessibility and i18n: swatches expose labels that include the
      color name and hex, highlighted rows append a screen-reader-only
      "highlighted" annotation, parent context-menu items remain
      keyboard-reachable through standard menu navigation, and every new
      user-facing string is extractable. Keyboard navigation inside the
      swatch grid is deferred beyond v1.
  - **Double-click a row** behavior splits by row type (issue #109):
    - **Primitive (leaf) rows** (string / number / boolean / null): copy the row's value to the clipboard with the same extraction semantics as the menu's **Copy value** action (raw text). Alt+double-click wraps the value as a JSON-string literal (DESIGN_SPEC.md §443). Emits the `tree.row.doubleClickCopyValue` telemetry event with `{ escaped: boolean }`.
    - **Container rows with children** (`object` / `array`): toggle the row's expansion state (expand if collapsed, collapse if expanded). Alt is ignored on container dblclick; right-click "Copy value" remains the way to copy a container's pretty-printed JSON. Emits the `tree.row.doubleClickToggle` telemetry event with `{ action: 'expand' | 'collapse' }` (post-toggle state).
    - **Empty containers** (`{}` / `[]`): no-op (no copy, no toggle, no telemetry). They render via the leaf template since `hasChild` is false, but the dblclick handler short-circuits before reaching the copy branch so the issue #109 wording ("objects and arrays should expand/collapse instead of copying") still holds.
    - In all cases the dblclick path excludes the kebab pill and twisty toggle the same way single-click selection does, so clicking those buttons twice never triggers the row dblclick handler.
  - **Keyboard copy (Ctrl+C / Cmd+C with tree focus)**: when a tree row has DOM focus, pressing `Ctrl+C` (Windows / Linux) or `Cmd+C` (macOS) copies that row's value to the clipboard with the same extraction semantics as the menu's **Copy value** action (raw text for primitives, pretty-printed JSON for containers). Unlike dblclick, the keyboard shortcut works on **every row, including empty containers** (`{}` / `[]`) - the user explicitly asked for "parent or leaf" parity, and keyboard copy has no expand/collapse alternative meaning to disambiguate. Expansion state is never altered. Modifier matching is strict: `Ctrl+Shift+C` (devtools) and `Ctrl+Alt+C` (AltGr on international layouts) are intentional no-ops; Alt is not honored, so this path always emits the raw (un-escaped) variant. Emits the `tree.keyboard.copyValue` telemetry event with `{ escaped: false }`.
  - **Search highlight** - a persistent search field is positioned above the tree view panel (on its own row, full-width, above the expansion controls):
    - User types arbitrary text into the search field; matching is **live** as they type (debounced ~150ms).
    - Any row whose key or value contains the search text (case-insensitive by default) is highlighted in the **search highlight color** (theme-aware default defined in `TreeHighlightColors`).
    - The matched substring within the key or value text has an **inline background highlight** so users can see exactly what matched.
    - A match count is displayed next to the search field (e.g., "12 matches").
    - **Previous / Next** navigation buttons (and `Enter` / `Shift+Enter` shortcuts) jump between matches, auto-expanding collapsed parent nodes as needed and scrolling the match into view.
    - **Highlight priority**: row backgrounds resolve from highest to lowest as selection highlight -> matching-value highlight -> ancestor highlight -> search highlight -> manual highlight -> formatting rules. Higher-priority highlights suppress lower-priority ones on the same row.
    - Options available via small toggles next to the search field: **case sensitive**, **regex mode**, **keys only / values only / both**.
    - Clearing the search field (or pressing `Escape` while focused in it) removes all search highlights.
    - The search field is always visible - it does not need to be toggled open.
    - Keyboard shortcut: `Ctrl+F` is **context-aware** - when the editor panel is focused, it triggers Monaco's built-in find; when the tree panel is focused (or no panel is focused), it focuses the tree search field.

- **Layout:** Split-pane (resizable). A 4-state segmented control in the toolbar picks one of `Editor only`, `Editor + tree side-by-side` (default), `Editor above tree`, or `Tree only`. The two "both" segments are direct-jump variants of `layoutOrientation` (which is roamed across devices); the two single-pane segments leave `layoutOrientation` untouched and persist locally under `jotjson.paneVisibility.v1` (parallel to `splitRatio`). When the user returns to a both-* segment, the previously saved `splitRatio` is automatically restored. On narrow viewports (< 768px) the rendering collapses to a single visible pane: when the persisted `paneVisibility` is `both`, the tree pane is shown by default (the app at narrow widths is primarily for *viewing* JSON; editing in Monaco at <= 360px is impractical). When the persisted choice is `editor-only` or `tree-only`, that single-pane choice is honored. The toolbar's segmented control collapses to a 2-state toggle (`editor-only` | `tree-only`) at narrow widths via SCSS - the two `both-*` segments are hidden so the highlighted segment is always one of the visible ones. The persisted `paneVisibility` is **never** mutated by the override; resizing the viewport back above 768px immediately restores the user's stored choice (including `both`). Single-pane segments remove the inactive pane and the splitter from layout via `display:none`.

- **Status bar** (always-visible strip along the bottom of the page, shipped in M7m):
  - **Left cluster**: meaningful character count (`Chars` - source UTF-16 code units after whitespace and comments are stripped, computed lexically via `jsonc-parser.createScanner`; preserves the user's chosen lexemes such as `1e3` and `1.0` rather than collapsing them via `JSON.stringify`; counts trailing commas in JSONC, an off-by-one limitation of at most one character per JSONC object/array), line count, byte size in UTF-8 (`Size`), current cursor position (`Ln X, Col Y`). Both `Chars` and `Size` carry a native `title=` tooltip explaining what the value represents (`Meaningful characters (no whitespace or comments)` and `Bytes if the document was downloaded as-is (UTF-8)` respectively).
  - **Right cluster** (parsed tree stats): total node count (labelled `Total Nodes`), max depth (`Max Depth`), object count (`Objects`), array count (`Arrays`), comment count (`Comments` - sourced from the parser-side comment harvester, surfaced as a dedicated `commentCount: number` field on `JsonParseResult` because the count cannot be derived from the post-harvest `CommentBundle` strings; rendered only when the document parsed successfully and `commentCount > 0`), a JSON / JSONC mode badge, and a build indicator. The build indicator currently shows the local-git short SHA (with a `*` suffix when the working tree was dirty) sourced from a build-time generated module, as a short-term placeholder pending M7n; M7n replaces it with a CI-authoritative `vX.Y.Z - <shortsha>` badge that links to the commit on GitHub and copies the full SHA on click. Each tree-stat (Total Nodes, Max Depth, Objects, Arrays, Comments) carries a native `title=` tooltip explaining what it counts; the visible labels do most of the clarification work and the tooltip is supplemental for sighted mouse users.
  - Stats update reactively as the user types. No interactivity beyond the version badge in v1.
  - On narrow viewports (< 768px) the bar collapses to a single-line summary per M7l, keeping Lines, Size (Bytes), and the Mode badge and hiding Chars, cursor, tree stats (Total Nodes / Max Depth / Objects / Arrays / Comments), and the build/version badge.

### 2. Persistent Link / Share  (`/s/:id`)

Available to **registered users** (create/manage). **Anonymous users can view any shared link** they have the slug for (both unlisted and public blobs).

- After submitting JSON, a registered user can click **"Save & Share"**.
- Generates a short, unique URL: `jotjson.com/s/abc123` (using the blob's NanoID slug).
- The link loads the saved JSON blob into the editor + tree view.
- **Visibility**: every saved blob is **private (unlisted) by default** - the link works for anyone who has it, but the blob is not listed on any public index, has a `noindex` meta tag, and does not emit rich Open Graph previews. The owner can toggle the blob to **public**, which enables Open Graph previews on `/s/:id` and allows indexing.
- Owner can update or delete the blob.
- **Fork-on-save**: a signed-in non-owner who saves edits to a shared blob
  creates a new blob owned by that user with its own slug. The original blob is
  unchanged, the source blob's manual highlights are copied into the fork, and
  the Home toolbar labels this action `Save as copy`.

### 3. Blobs + History Pages

Available to **registered users** only. Both routes are guarded by
`authGuard`.

#### 3a. Blobs page (`/blobs`, shipped in M4b)

Originally lived at `/history` but renamed to `/blobs` in M5b when
the event timeline (3b) took over that URL. The component and its
per-row behavior are unchanged.

- Lists the signed-in user's saved blobs, sorted by `updatedAt` DESC.
- Each row shows: title (or "Untitled" when the blob has no title) linking to `/s/:slug` to open it, the slug, a relative updated-at time (e.g., "3 hours ago"), and a `public` badge when `isPublic` is true.
- Per-row actions: **Copy link** (writes `https://jotjson.com/s/:slug` to the clipboard) and **Delete** (confirms via dialog, then removes the blob server-side and from the list).
- Loading state renders a three-row pulsing skeleton; empty state reads "You haven't saved any JSON blobs yet." with an "Open the editor" CTA.
- No pagination needed in v1 - the 100-blob quota keeps the list small.
- **Future enhancements (post-v1):**
  - Fallback title: show the first ~80 characters of the JSON body when `title` is absent, instead of "Untitled".
  - Additional metadata per row: save date (absolute) and byte size.
  - Search and filter by date range or keyword.
  - Inline public/private toggle on the list row (today this lives in the toolbar overflow menu on `/s/:slug`).
  - Infinite scroll if/when quotas increase.

#### 3b. Recently viewed page (`/history`, M5b - narrowed in v1)

The "Recently viewed" timeline. Shows shared blobs the signed-in
user has recently opened. URL preserved at `/history` for backward
compatibility.

- **Shape**: grouped by day ("Today", "Yesterday", `<date>`). Each
  row renders an eye icon, the blob's snapshotted title (falling
  back to the slug, then to "(deleted blob)" when both are missing),
  the verb "Viewed", and a relative time.
- **Click behavior**: clicking a row that still references a live
  blob navigates to `/s/:slug`. Rows whose blob has since been
  deleted are non-interactive.
- **Pagination**: `GET /api/history` returns a page of entries with a
  Cosmos continuation token; the UI uses an IntersectionObserver to
  auto-load the next page and exposes a "Load more" button as an
  a11y/keyboard fallback.
- **Filters**: timeline supports `?q=` (case-insensitive substring
  match on title/slug) and `?from=`/`?to=` (ISO timestamps,
  inclusive). Combined client-side via a debounced search field and
  a date range row. The v1 narrowing removed the action-filter
  chips - only `viewed` rows are surfaced.
- **Empty state**: "No recently viewed blobs yet."
- **Loading state** + error toast reuse the patterns from
  `/blobs`.
- **Clear history** action (calls `DELETE /api/history`, confirms
  via dialog, then returns to the empty state).
- **What is tracked**: controlled by the `recentlyViewedEnabled`
  preference (default on). When on, opening a shared blob owned by
  another user records one `viewed` entry, debounced to one entry
  per `(user, blob)` per 5 minutes.
- **What is NOT tracked**: anonymous views (no `userId` to
  attribute), owners re-loading their own blob, the user's own
  saves / edits / deletes (those already live on `/blobs`), and
  paste events.

### 4. Auth Pages

- **Sign Up / Sign In** - handled via Microsoft Entra External ID hosted UI (redirect to Microsoft-hosted login page, customizable via External ID user flows).
- Options for v1: email + password, Google (social identity provider via External ID). GitHub may be added in a later polish step.

### 5. Profile & Settings Page  (`/profile`)

Available to **registered users** only. The route is auth-guarded.

#### Shipped in v1 (M3b, M5d)

- **Identity card** (M3b)
  - Display name (read-only, sourced from the Entra External ID
    `name` / `preferred_username` claim).
  - Email (read-only, from the identity provider; shown as "Not
    provided by your identity provider" when the claim is absent).
  - Sign-out button.

- **Preferences card** (M5d) - changes auto-apply via
  `PreferencesService.update()`; no Save button. Each control writes
  through to the existing debounced server PUT for signed-in users.
  - **Editor**: font size (8-32 px, clamped), tab size (2 / 4),
    word wrap toggle.
  - **Tree**: font size (8-32 px, clamped), a "Fit tree to window"
    checkbox above the depth slider (when checked -- the default for
    new users -- the slider is disabled and the tree uses
    viewport-aware auto-fit; when unchecked, the slider drives a fixed
    initial expansion depth), default expansion depth
    (1-10, clamped), show type labels toggle, date annotations master
    toggle (`treeShowDateAnnotations`).
    - Date annotation sub-controls: year, month, day, hour, minute,
      and second unit toggles independently enable/disable units in the
      relative-time formatter; Use friendly phrases controls whether
      `Intl.RelativeTimeFormat` uses `numeric: "auto"` (e.g.,
      "yesterday", "tomorrow", "last month") or always-numeric output
      (e.g., "in 1 day", "1 month ago"). All sub-controls are disabled
      while `treeShowDateAnnotations` is off. All-units-off acts as a
      hidden kill switch -- the annotation is suppressed entirely and
      the master toggle is not auto-flipped. When the delta is smaller
      than the smallest enabled unit, the formatter renders that
      smallest-unit value as a decimal with adaptive precision: try
      1 decimal place, then grow to 2, 3, and 4 until the rounded value
      is non-zero; if all four levels still round to 0, accept 0.
      Defaults preserve existing behavior: all six unit booleans are
      `true`, and `friendlyForms` is `true`.
  - **Search**: scope (keys / values / keys and values), case
    sensitive toggle, regex mode toggle.
  - **Highlights**: per-theme color pickers for selected row,
    matching values, ancestor chain, search hits, and the default
    manual-highlight color.
  - **History & storage**: recently-viewed tracking toggle (records
    `viewed` entries when you open shared blobs you don't own; on
    by default), blob quota strategy (auto-delete oldest /
    ask me to choose).
  - **Appearance**: theme (dark / light / match system), layout
    orientation (horizontal / vertical). The header theme toggle
    and toolbar layout button continue to work; all surfaces share
    `PreferencesService` state.

#### Planned (later milestones / post-v1)

- **Account Section**
  - Edit display name (today it is read-only).
  - **Upload / change avatar** - accepts **PNG, JPEG, or WebP**; client-side validation rejects other formats. Max file size: **2 MB** (toast if exceeded). Client-side crop-to-square UI, then resize to **256x256** before upload. Stored in Azure Blob Storage, URL saved to the user profile. A "Remove avatar" option reverts to a generated default (initials on a tinted background).
  - **Change password** - triggers the Entra External ID password reset flow (redirect to the self-service password reset user flow). Applies to email/password users only; hidden for social login accounts.
  - **Linked accounts** - show which social providers are connected (Google, GitHub). Allow linking/unlinking additional providers.
  - **Delete account** - confirmation dialog, then deletes user profile, all blobs, history, and rule sets. Irreversible.

- **Preferences Section - deferred items**
  - **Default formatting rule sets** (M6) - multi-select listing the user's owned rule sets. Selected sets become the user's `activeRuleSetIds` preference, mirrored as toolbar chips on the home page; the same selection appears in both places and persists across sessions and devices.

- **Data & Privacy Section**
  - **Export my data** - enqueues a background job to generate a ZIP of all blobs, history, and rule sets. User receives a download link when ready (polled via `GET /api/me/export/:jobId`). The download URL is a pre-signed Azure Blob Storage SAS link valid for **1 hour** from generation; if it expires, the user can re-request a new export. Avoids Azure Functions timeout limits.
  - **Clear all history** - one-click purge of history entries.
  - **Clear all blobs** - delete all saved JSON blobs (with confirmation).

### 6. Landing / Marketing Elements

**Planned (post-v1).** v1 opens directly into the editor - the
homepage renders the global header + the toolbar + the editor/tree
split pane with no marketing chrome above or below. Planned additions:

- Hero section on `/` (above the editor when not yet interacting): tagline, "Paste your JSON to get started" CTA.
- Footer: About, Privacy Policy, Terms, GitHub link.

### 7. Formatting Rules Page  (`/formatting-rules`)

Available to **registered users** only.

- **Rule Set Manager** - users create named rule sets (e.g., "Error Highlighter", "API Status Codes").
  - Each rule set contains one or more formatting rules.
  - Users can switch between rule sets or apply multiple simultaneously.
  - A "default" rule set is auto-applied if set by the user.
  - **List ordering / precedence:** rule sets are sorted by `createdAt`
    (oldest first) everywhere they're listed - the user's
    `/formatting-rules` page, the active-set toolbar above the tree,
    and the engine's evaluation order. `createdAt` is immutable, so
    precedence is stable across edits and renames. Drag-to-reorder is
    a post-v1 follow-up that introduces an explicit `position` field.

- **Rule Builder UI** - for each rule:
  - **Target:** four-option selector:
    - "Key" maps to a simple rule with `target: "key"`.
    - "Value" maps to a simple rule with `target: "value"`.
    - "Key or value (either)" maps to a simple rule with
      `target: "key_and_value"`; the wire field is not renamed.
    - "Key + value (both must match)" maps to `kind: "pair"` with
      separate `keyMatch` and `valueMatch` sub-objects.
    New and renamed editor strings must use stable Angular i18n IDs in
    `<area>.<element>.<purpose>` form, e.g.
    `@@ruleEditor.target.keyOrValue` and `@@ruleEditor.target.pair`.
  - **Match type:** exact match, contains, starts with, or ends with.
    (`regex` is **deferred to v1.1**; see "Regex policy" below.)
  - **Match value:** the literal string to match against (max 200 chars).
  - **Case sensitivity** toggle.
  - **Style picker:** visual controls for:
    - Background color (color swatch picker).
    - Text color.
    - Bold / italic / underline toggles.
    - Border/outline color.
    - Optional icon badge - closed whitelist (`warning`, `check`,
      `star`, `info`, `error`, `flag`, `bookmark`). Picking an icon
      also opts the rule into the **Beacon surfacing UI** (see below).
  - **Live preview** - a sample JSON snippet updates in real time as the user configures the rule, showing how matches will look.
  - **Field-length caps:** rule-set `name` <= 80 chars, rule
    `matchValue` <= 200 chars. Enforced in `api/src/shared/limits.ts`
    and validated server-side; the editor surfaces the cap inline.
  - **Valid-only autosave:** the editor maintains a local draft and
    only fires the debounced PUT when the draft passes structural
    validation (required fields present, hex colors well-formed,
    matchValue within length cap). Invalid drafts surface an inline
    error and an "Invalid - fix to save" status indicator instead of
    spamming 400s.

- **Match semantics:**
  - Simple text rules (`kind` missing or `kind: "simple"`) match the
    **rendered text** the user sees in the tree, not the underlying
    JSON literal. So a `value contains "200"` rule matches the JSON
    number `200` (rendered as `200`), the JSON string `"200"`
    (rendered as `"200"` - the quotes are styling, not part of the
    matched text), `null`/`true`/`false` (rendered as their literal
    text). This keeps the user's mental model "what I see is what
    matches" for text matching.
  - Simple `target: "key_and_value"` keeps the legacy OR-on-fields
    semantics. It uses one text condition and applies when the key, the
    value, or both match. The editor labels this mode "Key or value
    (either)" so it is not confused with pair rules.
  - Pair rules (`kind: "pair"`) are a true cross-field AND: `keyMatch`
    and `valueMatch` must both match the same node before any style is
    applied. Key matching is text-only. Value matching can be text or
    one of the value predicates in the truth table below.
  - **Container nodes** (object `{}` and array `[]` rows) remain
    excluded from simple value-target text rules because they have no
    scalar value text to match. They remain eligible for key-target
    rules via their property name. Pair value predicates can evaluate
    object and array container rows via `valueKind` and `isEmpty`; pair
    value text matches are skipped when `valueText` is `null`.
  - Rules whose match config is structurally invalid (empty
    `matchValue`, unknown enum, unknown `kind`, etc.) are skipped at
    evaluation time by clients that read them defensively. API writes
    reject malformed or unknown rule shapes before persistence.

#### Predicate truth table

Pair-rule predicates evaluate against the deterministic formatting value
kind described below. The first-ship predicate set is intentionally an
18-value closed set covering existence, emptiness, content, and JSON type
checks.

- `is_null`: true iff `valueKind === 'null'`.
- `is_string`/`is_number`/`is_integer`/`is_boolean`/`is_object`/`is_array`: true iff `valueKind === '<type>'`. Their `is_not_X` forms are negations.
- `is_number` and `is_integer` are mutually exclusive (matches `value-classifier.ts:154-157`). Document that users wanting "any numeric" combine the two.
- `is_empty`: true iff `(valueKind === 'string' && valueText === '') || (valueKind === 'array' && isEmpty) || (valueKind === 'object' && isEmpty)`. False for `null`, `0`, `false`, `'   '` (whitespace).
- `is_not_empty`: inverse.
- `has_content`: true iff `is_not_null && is_not_empty`; matches values that are not null and not empty, including whitespace strings, numbers, booleans, and non-empty containers.
- `lacks_content`: inverse of `has_content`; true for `null`, `""`, `[]`, and `{}`.

| Predicate | True when |
|---|---|
| `is_null` | `valueKind === 'null'` |
| `is_not_null` | negation of `is_null` |
| `is_empty` | `(valueKind === 'string' && valueText === '') || (valueKind === 'array' && isEmpty) || (valueKind === 'object' && isEmpty)` |
| `is_not_empty` | inverse of `is_empty` |
| `has_content` | `is_not_null && is_not_empty` |
| `lacks_content` | inverse of `has_content`; `null`, `""`, `[]`, or `{}` |
| `is_string` | `valueKind === 'string'` |
| `is_not_string` | negation of `is_string` |
| `is_number` | `valueKind === 'number'` |
| `is_not_number` | negation of `is_number` |
| `is_integer` | `valueKind === 'integer'` |
| `is_not_integer` | negation of `is_integer` |
| `is_boolean` | `valueKind === 'boolean'` |
| `is_not_boolean` | negation of `is_boolean` |
| `is_object` | `valueKind === 'object'` |
| `is_not_object` | negation of `is_object` |
| `is_array` | `valueKind === 'array'` |
| `is_not_array` | negation of `is_array` |

`is_number` and `is_integer` are mutually exclusive, matching the
existing classifier behavior in `src/app/shared/utils/value-classifier.ts`
lines 154-157. Users who want "any numeric" combine the two, usually as
two rules that share the same style.

`has_content` and `lacks_content` are mutually exclusive and exhaustive.
`is_empty` is false for `null`, `0`, `false`, and `'   '` (whitespace).
`has_content` still excludes `null`, but includes whitespace strings,
numbers, booleans, and non-empty containers because only the exact empty
string matches.

#### Lifecycle

Pair and predicate rules use the same evaluation lifecycle as today's
text rules: `evaluateFormattingRules` runs lazily per node during tree
rendering, the result is memoized by the per-node cache in
`json-tree.component.ts`, and evaluation automatically re-runs when JSON
content or active rule sets change. There is no pre-pass at content-load
time and no manual trigger. The memo cache key must include `valueKind`
and `isEmpty` in addition to the existing key/value text and rule-set
fingerprint so predicates do not reuse stale text-match results.

#### Deterministic classifier

Predicate evaluation must not depend on user preferences such as
`treeAssumeUtcForIsoDateTime`; the same saved rule set must highlight the
same nodes for every viewer, tab, and device. Formatting predicates
therefore use a dedicated deterministic helper at
`src/app/shared/utils/formatting-value-kind.ts`, separate from the
preference-sensitive search classifier in
`src/app/shared/utils/value-classifier.ts`. The helper classifies the JSON
value into `valueKind` and `isEmpty` for the engine.

#### Stale-tab graceful degradation

Clients must read rules with the defensive pattern
`rule.kind ?? 'simple'`. Consumers that encounter an unknown `kind`
skip that rule rather than throwing, and must not read legacy fields such as
`matchValue` until after the rule is known to be simple. No
version-mismatch force-refresh is required in v1. On the API side,
create/update validators enforce a closed set for `kind`,
`valueMatch.kind`, `predicate`, `target`, and `matchType`, and reject
unknown fields so invalid future shapes are not persisted by current
servers.

#### Deferred / out-of-scope (this iteration)

- Format predicates: `is_date`, `is_uuid`, `is_url`, `is_email`,
  `is_ipv4`, `is_ipv6`, `is_path`, `is_date_time`.
- N-ary clause-list rules beyond the single key/value pair AND.
- Predicates on the key side; keys remain text-only.
- Wire-field rename of `target: "key_and_value"`; only the
  user-visible label changes.
- Built-in preset using pair rules.

- **Regex policy (v1):** the `regex` match type is **not shipped in
  v1**. Native JavaScript regex has no execution timeout, and a
  user-supplied pathological pattern run across every node of a 5 MB
  tree is a real DoS surface for our own client. Shipping
  `exact / contains / starts_with / ends_with` covers the common cases
  in the built-in presets and most user requests; pulling regex back
  in is planned for v1.1 alongside a `safe-regex`-style guard and a
  compile-once cache.

- **Concurrency:** every rule set carries a numeric `version` field
  that the API increments on every successful `PUT`. The API surfaces
  `version` as a strong `ETag` response header on `GET` and
  `POST`/`PUT` responses; clients echo it via `If-Match` on the next
  `PUT`. A mismatched `If-Match` returns **412 Precondition Failed**;
  the editor surfaces a "This rule set was changed in another tab -
  reload to keep editing" banner and disables further autosaves until
  the user resolves it. This avoids silent multi-tab clobbering.

- **Update payload:** `PUT /api/rule-sets/:id` is a **full replace** of
  the rule-set document body (`name` + `rules`), matching
  `PUT /api/blobs/:id` semantics. Unknown top-level fields are
  rejected (consistent with the `me.ts` PUT pattern).

- **`activeRuleSetIds` referential integrity:** when an applied rule set is
  deleted, the `DELETE /api/rule-sets/:id` handler strips the deleted ID
  from `activeRuleSetIds` on the user document in the same request.
  Clients refresh local prefs after a successful delete. The wire surface
  emits only canonical `activeRuleSetIds`; `normalizeStoredPreferences`
  strips the legacy `defaultRuleSetIds` (post-M6f-5, pre-issue #83) and
  `defaultRuleSetId` (pre-M6f-5) keys on read so they never reach the
  wire, and stale stored docs missing the canonical key default to `[]`.
  See -> Versioning -> Schema evolution for the playbook used by future
  renames.

- **Engine output / `target` projection:** the formatting-rules engine
  is a pure function `evaluate(activeSets, node) -> RuleEngineResult`
  with shape:
  ```
  {
    rowStyle: { backgroundColor?, borderColor? },
    keyStyle: { color?, bold?, italic?, underline?, icon? },
    valueStyle: { color?, bold?, italic?, underline?, icon? },
    matchedRules: { setId, ruleId, label }[]
  }
  ```
  - For `kind: "simple"`, the legacy `target` wire field is
    unchanged: `target=key` -> `keyStyle`, `target=value` ->
    `valueStyle`, and `target=key_and_value` ("Key or value (either)"
    in the editor) styles whichever side's single text condition
    matched, or both if both sides matched.
  - For `kind: "pair"` ("Key + value (both must match)" in the
    editor), `keyMatch` and `valueMatch` must both match the same node
    before style applies; inline style projects to both `keyStyle` and
    `valueStyle` on a match.
  - `backgroundColor` and `borderColor` always project onto `rowStyle`
    (they paint the row, not the inline tokens).
  - Within a set: rules merged in array order; later rules override
    earlier on conflicting per-target properties.
  - Across active sets: sets evaluated in user-list (`createdAt`)
    order; later sets override earlier.
  - The tree row applies the result via CSS custom properties
    (`--tree-row-bg`, `--tree-key-color`, etc.) so it composes cleanly
    with the existing `tree-value-string` / `tree-key` token classes
    rather than fighting them via specificity.

- **How it works in the Tree View:**
  - When a rule set is active, the tree view scans each node's key and value.
  - Matching nodes receive the configured inline styles (background, text color, font weight, etc.).
  - **Within a rule set:** multiple rules can match the same node. Style projection is **additive across non-conflicting fields**: scalar properties (text color, bold, italic, underline, background, border) are last-wins across overlapping rules, but `icon` is set-union - if three rules with three different icons all match, the row surfaces all three icons (deduped, in first-occurrence order). This lets a row simultaneously be e.g. red-background AND error-icon AND bold without one rule clobbering the other's contribution.
  - **Across active rule sets:** sets are evaluated in `createdAt` order (oldest first) - the same order they appear in the user's saved list and the formatting toolbar. Later evaluations override earlier ones for conflicting scalar style properties; icons continue to accumulate across sets. Drag-to-reorder of active sets is a post-v1 follow-up.
  - The optional `borderColor` style renders as a 4px left-edge accent strip on the affected row (consistent with the `.pref-substack` pattern on the profile page) so it does not collide with the selection outline or ancestor highlights.
  - A tooltip on hover shows which rule(s) matched a given node (keeps the tree visually clean). Tooltip labels are auto-generated from each rule's match config.
  - **Highlight priority** (highest to lowest): selection highlight -> matching-value highlight -> ancestor highlight -> search highlight -> manual highlight -> formatting rules. Higher-priority highlights suppress lower-priority ones on the same row.
  - A **formatting toolbar** above the tree view lets users quickly toggle rule sets on/off or pick which set to apply. Toolbar state is the user's `activeRuleSetIds` preference and persists across sessions and devices; the same selection appears in the Profile "Default rule sets" multi-select.

- **Built-in Presets** - ship a few starter rule sets users can clone and customize. Preset IDs are stable kebab-case slugs (not UUIDs) so the clone endpoint URLs are human-readable and stable across rebuilds; user-created rule sets always get UUIDs.
  - `error-detection` ("Error Detection") - highlights keys and values that name an error / failure concept in red, and surfaces each match as a beacon (the rule carries the `error` icon by default). Six rules, all case-insensitive: `error`, `exception`, `failure`, `failed` use `contains` against both keys and values (so `{"data":"TypeError"}` highlights the value); `err` targets keys only and uses `exact`-match because case-insensitive contains-match for "err" hits common English words in arbitrary text (merry, berry, where, every) and the embedded-error keys are already covered by the `error` rule; `fault` uses `starts_with` so the very common word `default` does not match while `fault`, `faultCount`, `FaultDetail` still do.
  - `status-codes` ("Status Codes") - color-codes a fixed list of common HTTP response code values via `exact` matches: `200`, `201`, `204` (green); `400`, `401`, `403`, `404` (amber); `500`, `502`, `503` (red). Individual rules per code rather than a single regex - a documented v1 trade-off until the regex match type lands in v1.1.
  - `null-finder` ("Null Finder") - highlights all `null` values with a yellow background.
  - `status-highlights` ("Status Highlights") - color-codes outcome and lifecycle vocabulary on both keys and values, case-insensitive. Green: `success`, `succeeded`, `passed` (`contains`), `ok` (`exact` - avoids partial matches like "took" / "look" / "broken" while still catching `{"status":"OK"}`). Amber: `warning`, `pending`, `retry` (`contains`), `warn` (`exact` - avoids "Warner" / "warned" while catching `{"level":"warn"}`).
  - `test-header-content` ("Test Header Content") - highlights values under keys named `test-header`, `testHeader`, or `test_header` with case-insensitive exact matching (so `Test-Header`, `TESTHEADER`, etc. also match). It uses complementary pair-value predicates: `has_content` paints red and carries the `warning` icon (so populated test-header values surface as beacons - usually noteworthy in production-side data); `lacks_content` paints green and carries no icon (an empty test-header is the boring/expected case). Because those predicates are mutually exclusive, a matched node's tooltip gets exactly one label. Whitespace-only strings like `"   "` are treated as content (red) because `is_empty` is strict-literal-empty. The preset paints row backgrounds, so when it is active with another row-background preset such as `null-finder`, the final color follows cross-set `createdAt ASC` precedence.

- **Limits (free tier):** max 20 rule sets per user, max 50 rules per rule set, rule-set name <= 80 chars, rule matchValue <= 200 chars. Enforced server-side as hardcoded constants in `api/src/shared/limits.ts` (mirrors the 100-blob cap pattern); raising them later is one edit.

- **Beacon surfacing UI** (0.10.0) - any rule whose `style.icon` is set
  becomes a "beacon": its matches surface in three places without any
  new schema or new opt-in.
  - **Inline icons** (existing): the engine already projects matched
    icons next to the key/value on the row itself.
  - **Ancestor badges**: a collapsed container row whose subtree
    contains hidden beacons renders one badge per icon-type next to
    the chevron (subtree icons minus the icons already on the row
    itself, so we never duplicate a visible icon as a badge). Click
    expands the path to and selects the first hidden match for that
    icon. Click stops propagation so the row's own click handler does
    not also fire.
  - **Toolbar pills** (`<jj-toolbar-beacon-pills>`): one pill per
    icon-bucket with at least one match in the current tree. Click
    cycles forward through the bucket in pre-order (depth-first); a
    Shift+click cycles backward. Per-icon cursors are kept locally and
    clamp on bucket shrink. The count chip appears only when the
    bucket has >= 2 matches.
  - **Cross-pane navigation**: pill clicks (and ancestor-badge clicks
    for parity / dashboard symmetry) emit jump intents through the
    root-provided `BeaconNavigationService`. `HomeComponent` subscribes
    via `takeUntilDestroyed()` and dispatches each request to the tree
    or to Monaco based on `paneVisibility()` plus a tracked
    `lastActivePane()` (updated on tree pointerdown / selection and on
    Monaco cursor moves; NOT updated by the click that produced the
    request - the dispatcher reads pre-click state). In `editor-only`
    or `tree-only` modes the visible pane is the unconditional target.
  - **Trigger discoverability**: the rule editor's icon picker has an
    inline hint
    (`@@ruleEditor.icon.beaconHint`) explaining that picking an icon
    opts the rule into the surfacing UI.
  - **Telemetry** (closed-enum props only - icon, direction, target,
    paneVisibility, source - plus bounded numeric measurements; no
    paths and no key/value content): `beacons.evaluated` (per
    recompute, skipped when nothing matched), `beacons.badge.clicked`,
    `beacons.pill.clicked`, `beacons.crossPane.dispatched`.

---

## User Flows

### Anonymous User
1. Lands on `jotjson.com`.
2. Pastes or types JSON into the editor.
3. Tree view renders in real time.
4. Can format, minify, copy output.
5. If they try to "Save & Share" or view history -> prompted to create an account.
6. Session data (current JSON) stored in browser `localStorage` so it persists across refreshes.

### Registered User
1. Signs in via Microsoft Entra External ID.
2. All anonymous features plus:
   - **Save & Share**: persists the blob to Cosmos DB, generates a shareable link.
   - **Blobs + History**: saved blobs appear on `/blobs` (the M4b blob list, renamed from `/history` in M5b), and the signed-in user's recent activity appears on `/history` as an event timeline (M5b). See §3 for both.
   - **Formatting Rules**: create custom highlighting rules that auto-apply to the tree view.
3. Session state syncs to server.

---

## API Design (Azure Functions)

Base path: `https://api.jotjson.com/` (or `/api/` proxied via Static Web Apps)

### Auth forwarding (SWA managed-Functions quirk)

Azure Static Web Apps' managed-Functions runtime **rewrites the incoming
`Authorization` header** with its own internal HS256 JWT before forwarding the
request to the Function. A bearer token placed on `Authorization` by the SPA
does not reach the Function as-is. To work around this, JotJSON uses a custom
header:

- **SPA -> API**: the auth HTTP interceptor attaches the Entra access token as
  `X-Jotjson-Authorization: Bearer <token>` on every `/api/*` request.
- **API**: `verifyAccessToken` reads `X-Jotjson-Authorization` first, then
  falls back to the standard `Authorization` header (used only by local
  `func start`, where SWA's rewriting does not apply).

**Every future protected endpoint, and every new API client, must use this
convention.** Do not rely on the standard `Authorization` header for
SPA-originated calls in production.

A local-only dev-auth bypass (gated on `JOTJSON_DEV_AUTH_BYPASS=true`,
the absence of `WEBSITE_INSTANCE_ID`, and `WEBSITE_HOSTNAME` being unset
or matching `localhost(:<port>)?`) accepts the
synthetic token form `dev:<userId>` for both `Authorization` and
`X-Jotjson-Authorization`; see `AGENTS.md` "Local-only dev-auth bypass"
for setup. The bypass cannot engage in any Azure-hosted environment.

### Shipped endpoints (v1)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | None | Liveness probe |
| POST | `/api/blobs` | Required | Create a new JSON blob |
| GET | `/api/blobs` | Required | List caller's blobs (newest first) |
| GET | `/api/blobs/:id` | Optional | Get a blob by UUID or slug. Public / unlisted blobs do not require auth; owner-only blobs (post-v1) will. |
| PUT | `/api/blobs/:id` | Required (owner) | Update a blob's content, title, `isPublic` flag, or manual highlights |
| DELETE | `/api/blobs/:id` | Required (owner) | Delete a blob |
| GET | `/api/me` | Required | Read the current user document. Returns 404 if not yet seeded. Response carries `ETag: "<version>"`. |
| POST | `/api/me` | Required | First-time seed: create the user document from the request body (typically the anon user's local preferences). Idempotent; 409 if already seeded. Response carries `ETag: "<version>"`. |
| PUT | `/api/me/preferences` | Required | Replace the preferences object with a validated + normalized copy. Requires `If-Match: "<version>"` (400 if missing/malformed, 404 if user not seeded, 412 on stale). Returns the normalized preferences and a fresh `ETag`. |

### Planned endpoints (later milestones / post-v1)

| Method | Endpoint | Auth | Planned in | Description |
|---|---|---|---|---|
| GET | `/api/history` | Required | M5a | Paginated `viewed` timeline for the caller, newest first (continuation token for pagination). Legacy non-`viewed` rows are filtered out on read. |
| DELETE | `/api/history` | Required | M5a | Clear all history entries for the caller |
| PUT | `/api/me` | Required | post-v1 | Update display name + avatar URL |
| POST | `/api/me/export` | Required | post-v1 | Enqueue data export job (returns job ID) |
| GET | `/api/me/export/:jobId` | Required | post-v1 | Poll export job; returns ZIP SAS URL when complete |
| DELETE | `/api/me` | Required | post-v1 | Delete account and all associated data |
| POST | `/api/rule-sets` | Required | M6 | Create a formatting rule set; response includes `version: 1` and an `ETag` header |
| GET | `/api/rule-sets` | Required | M6 | List user's rule sets (sorted by `createdAt` ascending) |
| GET | `/api/rule-sets/:id` | Required (owner) | M6 | Get a rule set by ID; response includes `ETag` header. Owner mismatch returns 403; missing ID returns 404 |
| PUT | `/api/rule-sets/:id` | Required (owner) | M6 | Update a rule set (full replace of `name` + `rules`). Requires `If-Match: <version>`; mismatch returns 412 Precondition Failed. Owner mismatch returns 403 |
| DELETE | `/api/rule-sets/:id` | Required (owner) | M6 | Delete a rule set. Removes the ID from the user's `activeRuleSetIds` if matching. Owner mismatch returns 403 |
| GET | `/api/rule-set-presets` | Required | M6 | List built-in preset rule sets. Uses a top-level path (not `/api/rule-sets/presets`) because the Azure Functions Node.js v4 router resolves the latter to the parameterized `/rule-sets/{id}` handler |
| POST | `/api/rule-set-presets/:id/clone` | Required | M6 | Clone a preset into the user's rule sets |

### Blob write semantics and concurrency

`POST /api/blobs` accepts optional `highlights`; when omitted the new
blob has no manual highlights. `PUT /api/blobs/:id` uses the existing
patch-style semantics for mutable blob fields: omitting `highlights`
leaves the stored sidecar unchanged, while providing `highlights` (even
`[]`) replaces the array wholesale. Blob saves send the current content,
title, visibility, and highlights through the same PUT surface.

Every `JsonBlob` carries a numeric `version` field. `GET /api/blobs/:id`,
`POST /api/blobs`, and successful `PUT /api/blobs/:id` responses include
the same value in the JSON body and as a strong `ETag` header, e.g.
`version: 3` with `ETag: "3"`. Clients must echo the loaded version on
every blob PUT as `If-Match: "<version>"`. Missing or malformed
`If-Match` is **400 Bad Request**; a stale version is **412 Precondition
Failed**. On 412, the client refetches, surfaces the conflict, and rebases
or prompts before retrying rather than silently clobbering another tab.

RuleSets and the user document use the same client-facing numeric
`version` / strong `ETag` / `If-Match` contract (see Formatting Rules
Page -> Concurrency, and `PUT /api/me/preferences`). Every Cosmos
`replace` in the API workspace goes through the
`replaceWithIfMatch` helper in `api/src/shared/cosmos.ts`, which
combines the client-facing version bump with Cosmos's internal
`_etag` `IfMatch` precondition so the update is atomically guarded
even if two writers race after reading the same version.
`scripts/check-prod-patterns.mjs` enforces this structurally: direct
`.item(...).replace(...)` calls are banned outside the helper, and
`.upsert(...)` is banned in `api/src/`. The helper plus the lint
tripwires together make IfMatch protection the default for every
`VersionedDocument`.

### Validation Rules
- Max raw blob content size: **1,000,000 UTF-8 bytes** (free tier).
- Total saved content-plus-highlights envelope: `JSON.stringify({ content, highlights: highlights ?? [] })` must be <= **1,016,512 serialized characters**. This preserves the 1,000,000-byte content allowance while bounding highlight overhead to 16,384 serialized characters plus a small JSON envelope.
- Manual highlights: max **100** per blob; `color` must be a 6-digit `#RRGGBB` hex string; `path` must be a unique canonical JSON tree path, non-empty, and <= **1024 characters**.
- Max blob title length: **200 characters**. The server trims surrounding whitespace before validating; a title that is empty or whitespace-only after trimming is stored as `undefined` (no title). Anything longer than 200 characters after trimming is rejected with a `BlobValidationError`.
- Must be valid JSON or JSONC (server re-validates using JSONC-aware parser).
- Rate limiting: 60 requests/min per IP (anonymous), 120/min (authenticated).
- **Blob quota (free tier: 100 blobs per user)** - when a user saves their 101st blob, the server automatically deletes the **oldest** blob (by `updatedAt`, then `createdAt` as tiebreaker) to make room. The user is notified via a toast: "Deleted oldest blob '[title]' to stay within your 100-blob limit." The first time this happens per user, a one-time modal explains the auto-delete behavior and offers "OK, got it" or "Let me manage manually" (which instead aborts the save with a prompt to delete blobs from `/blobs`). This choice is remembered as a user preference (`blobQuotaStrategy`: `"auto_fifo"` default or `"manual"`).

---

## Non-Functional Requirements

### Performance
- Tree view should render blobs up to **5 MB** without freezing the UI (use virtual scrolling for large trees).
- Time-to-interactive < 2 seconds on 4G connection.
- API response time < 200ms (p95) for blob CRUD.

### Security
- All traffic over HTTPS (enforced by Azure Static Web Apps' built-in SSL).
- Microsoft Entra External ID handles all credential storage - no passwords in Cosmos DB.
- **MSAL cache lives in `localStorage`** (not `sessionStorage`) so signed-in
  state survives tab close and browser restart. The SPA reads the cached
  account on app start to hydrate the `signedInUser` signal without a full
  redirect round-trip. Sign-out explicitly clears MSAL cache and the local
  preferences copy.
- Input sanitization: JSON blobs are treated as opaque strings, never rendered as HTML.
- Same-origin deployment: the SPA and `/api/*` share `jotjson.com`, so there is no cross-origin CORS preflight at the edge. If/when a separate API origin is added, CORS will be restricted to `jotjson.com` origins.
- **Global response headers** (set in `staticwebapp.config.json` `globalHeaders`):
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: SAMEORIGIN` - blocks third-party iframing (clickjacking) but permits same-origin iframing, which is required by MSAL silent token refresh: MSAL loads a hidden iframe at the IdP's `/authorize` endpoint with `prompt=none`, and the IdP's 302 response navigates that iframe back to `https://jotjson.com/#code=...` so MSAL can read the auth code from the fragment. `DENY` blocks that final navigation and forces every silent refresh into an `InteractionRequiredAuthError`, which the auth interceptor maps to an unauthenticated request and a 401. `SAMEORIGIN` is the standard configuration for any site using MSAL silent refresh.
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: clipboard-read=(self), clipboard-write=(self)` - scopes the Clipboard API to the site's own origin so the Smart Paste polling (Home page §1) can read the clipboard without cross-origin leakage.
  - **Content Security Policy** - shipping as Report-Only during a production observation window, then flipped to enforced. The full policy is checked in to `staticwebapp.config.json` and covers `script-src` (with `'unsafe-eval'` for Monaco's AMD loader and a SHA-256 hash for the inline splash script), `style-src` / `style-src-elem` / `style-src-attr` (with `'unsafe-inline'` because Angular and Material inject runtime styles and SWA cannot mint per-request nonces), `worker-src 'self' blob:` (Monaco + the JSON tree extractor worker), `connect-src` and `frame-src` for Entra (`*.ciamlogin.com`, `login.microsoftonline.com`) and App Insights ingestion (`*.in.applicationinsights.azure.com`, `*.livediagnostics.monitor.azure.com`), plus `frame-ancestors 'self'` (matches `X-Frame-Options: SAMEORIGIN` so MSAL silent refresh continues to work once CSP enforces), `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, and `upgrade-insecure-requests`. `scripts/check-csp-hashes.mjs` is wired into the lint chain (`--src`), the production build (`--dist`), and CI (`--ci-origins`, which validates that the secret-baked authority and App Insights ingestion hosts are still covered by the policy). See "CSP allowlist" further down for the App Insights origin rationale.

### Scalability
- Cosmos DB serverless scales automatically.
- Azure Functions consumption plan scales to zero when idle.
- CDN caches static assets aggressively.

### Reliability
- Anonymous blobs are not persisted server-side - they live only in the browser's `localStorage`. Registered user blobs persist indefinitely (free tier: up to 100 blobs).
- Cosmos DB automatic backups.

### Accessibility
- WCAG 2.1 AA compliance.
- Keyboard-navigable tree view.
- Screen-reader-friendly labels.

### Internationalization (i18n)
- **v1 ships in English only.**
- The app is **architected for future i18n** using Angular's built-in `@angular/localize` tooling. All user-facing strings are authored as extractable messages (via `i18n` attributes / `$localize` tagged templates) from day one so additional languages can be added later without a rewrite.
- Dates, times, and relative-time annotations in the tree view already use `Intl.DateTimeFormat` / `Intl.RelativeTimeFormat` with the user's browser locale (independent of UI language).

### SEO / Social

- **Static prerender at build time** for `/` and `/404` via `@angular/ssr` with
  `outputMode: "static"` and a `ServerRoute[]` configuration in
  `src/app/app.routes.server.ts` (`/` and `/404` -> `RenderMode.Prerender`,
  everything else -> `RenderMode.Client`). Crawlers and social unfurlers see
  real HTML for the homepage and 404 page without a server runtime.
- **Shell fallback for every other route.** `scripts/postbuild-seo.mjs`
  renames Angular's `index.csr.html` to `shell.html` post-build.
  `staticwebapp.config.json`'s `navigationFallback.rewrite` points at
  `/shell.html`, which boots the SPA exactly as the pre-M7h `index.html` did
  (static splash + Angular bootstrap). Auth-gated routes (`/blobs`,
  `/history`, `/profile`, `/formatting-rules*`) and dynamic routes
  (`/s/:slug`) all flow through the shell.
- **Splash UX preservation.** `scripts/postbuild-seo.mjs` injects
  `<meta name="prerendered" content="true">` into prerendered HTML files
  only. `LoadingSplashService` reads this marker at construction; when
  present it pre-latches `firstNavComplete = true` so the Angular splash
  (`<app-loading-splash>`) never paints on top of the prerendered home
  content. Shell-fallback boots have no marker and continue the legacy
  splash lifecycle.
- **Server-platform safety.** No client hydration in v1 - prerender is a
  "head start" for crawlers and first paint, not a hydration source.
  Browser-API call sites that run during construction or eagerly-fired
  effects (`window`, `localStorage`, MSAL) are guarded with
  `isPlatformBrowser(inject(PLATFORM_ID))`. A server-only `app.config.server.ts`
  provides MSAL no-op stubs and skips `provideServiceWorker` /
  `provideAppInitializer(AuthService.initializeFromRedirect)`.
- **Open Graph + Twitter defaults** on `src/index.html` cover the homepage
  and survive into the prerendered `index.html`. Per-blob OG/Twitter and
  `noindex` for unlisted blobs are still set client-side by `SeoService`
  (M4c). `home.component.ts`'s constructor effect that wipes OG tags when
  no blob is loaded is gated on `isBrowser` so the static defaults are not
  stripped during prerender.
- **`og.png`** at `public/og.png` (1200x630, `summary_large_image`).
- **`robots.txt` + `sitemap.xml`** at `public/robots.txt` and
  `public/sitemap.xml`, listing `https://jotjson.com/` (homepage only;
  /404 is excluded from sitemaps).
- **404 noindex.** `NotFoundComponent.ngOnInit()` calls
  `seo.setNoindex(true)` and `seo.clearBlobTags()`, both of which fire
  during the `/404` prerender so the emitted HTML carries
  `<meta name="robots" content="noindex">` for crawlers.
- **Service worker config.** `ngsw-config.json` `index` is `/shell.html` so
  the SW falls back to the SPA shell for unknown navigation URLs.
  Prerendered `/index.html` and `/404/index.html`, plus `og.png`,
  `robots.txt`, and `sitemap.xml`, are precached.
- **Build-time integration check.** `scripts/check-prerender.mjs`
  (npm `check:prerender`) validates the dist layout, marker placement,
  brand text, OG defaults, noindex, and asset presence after every build.
- **Out of scope for v1** (tracked as priority:low follow-up issues):
  - Server-visible OG / `noindex` for `/s/:slug`. Slug space is unbounded
    and per-blob visibility is dynamic, so static prerender cannot
    satisfy this. Issue: `followup-share-og`.
  - True HTTP 404 status for unknown paths. SWA's `navigationFallback`
    returns 200 and would need `responseOverrides` config. Issue:
    `followup-true-404`.

### Progressive Web App (PWA)
- The site is installable as a **browser app** (PWA) on desktop and mobile.
- **Shipped in v1:**
  - **Web App Manifest** (`public/manifest.webmanifest`, linked from `index.html`):
    - `name`: "JotJSON", `short_name`: "JotJSON"
    - `display`: `standalone` (runs without browser chrome).
    - `start_url`: `/`
    - `theme_color` and `background_color` matching the app's dark/light theme.
    - Icons at standard sizes: 192x192, 512x512 (maskable + any).
    - `categories`: `["developer-tools", "utilities"]`
  - **Service Worker** via Angular's `@angular/service-worker`, registered in `app.config.ts` with `registerWhenStable:30000` and disabled in dev mode. Configured via `ngsw-config.json` with cache-first for app-shell assets (HTML, CSS, JS, fonts, icons) so the editor/tree view load offline once the app has been visited.
  - **Network-first cache for `/api/**`** via `ngsw-config.json` `dataGroups`: strategy `freshness`, 5-second network timeout, 1-hour `maxAge`, 100-entry `maxSize` - the SW serves fresh responses when the network is available and transparently falls back to the cached copy otherwise.
  - **Update prompt**: `AppUpdateService` (in `core/update/`) subscribes to `SwUpdate.versionUpdates` and surfaces a non-dismissing Material snackbar ("A new version of JotJSON is available.") with a Reload action when a new build is deployed. Also subscribes to `SwUpdate.unrecoverable` and hard-reloads with a cache-busting query so a mid-deploy CDN race on a force-refresh cannot leave the user on a stalled page.
  - **Deployment cache headers**: `staticwebapp.config.json` sets `Cache-Control: no-cache, must-revalidate` on `/index.html` and `/ngsw.json` so browsers revalidate the shell + SW manifest on every load, shrinking the window where stale references can collide with a new build.
- **Planned polish (post-v1):**
  - **Install button**: handle `beforeinstallprompt` in the header to offer a subtle "Install JotJSON" affordance; hide once installed.
  - **Manifest screenshots**: add at least one wide and one narrow `screenshots` entry to the manifest for richer install prompts (not yet present in `manifest.webmanifest`).
  - **Offline banner**: show a persistent banner driven by `navigator.onLine` + SW status when network is unavailable, auto-dismiss when connectivity returns.
  - **Offline fallbacks for API-dependent features** (save, share, history, formatting rules): show a "You're offline" state and queue actions for sync.
  - **Background sync**: flush queued blob saves when connectivity is restored (needs a custom SW integration on top of ngsw).

---

## UI/UX Guidelines

- **Theme:** Clean, developer-friendly. Defaults to the system theme (follows OS `prefers-color-scheme`); falls back to dark when the OS preference is unknown. User can override via the theme toggle.
- **Typography:** Monospace font for JSON content (e.g., JetBrains Mono, Fira Code). Sans-serif for UI chrome.
- **Color Palette:**
  - Primary: Teal/Cyan accent (#00BCD4 family).
  - Background: Dark (#1E1E1E) / Light (#FAFAFA).
  - JSON types color-coded. Per-theme palettes live with the surfaces
    that use them: tree value colors in
    `src/app/shared/components/json-tree/json-tree.component.scss`
    (the `--tree-string-color` / `--tree-number-color` / `--tree-boolean-color`
    / `--tree-muted-color` CSS variables, set in dark and light blocks),
    Monaco editor syntax tokens in `src/app/shared/components/json-editor/json-editor.component.ts`
    (`defineThemes()` `rules` arrays for `jotjson-dark` and
    `jotjson-light`), and user-customizable highlight colors in
    `TreeHighlightColors` (defaults in this document).
- **Logo:** "JotJSON" wordmark - "Jot" in regular weight, "JSON" in bold, with a `{ }` icon element.
- **Responsive breakpoints:** Mobile (< 768px), Tablet (768-1024px), Desktop (> 1024px).

### Error, Loading & Empty States

- **Cold-boot splash:** a static HTML splash (logo + thin top bar + label) is inlined into `<app-root>` in `index.html` so it renders before any JS executes. The label is "Loading JotJSON..." for every URL (no URL-sniffing inline script); the label transitions through "Downloading JSON..." (download stage) and "Rendering tree..." (render-pending stage) once Angular bootstraps and `LoadingSplashComponent` takes over. Angular's `bootstrapApplication` removes the static markup automatically on first render. The splash respects `prefers-color-scheme` and `prefers-reduced-motion`. The pre-Angular-bootstrap "Loading JotJSON..." string is an i18n exception by necessity (the i18n pipeline runs after bootstrap). On cold-boot deep-links to `/s/:slug` the static "Loading JotJSON..." flashes briefly into "Downloading JSON..." once Angular is up; this brief flicker is accepted in exchange for distinct lifecycle stages (the previous M8 "Loading JSON..." preempt would conflate the bootstrap and download stages on a `/s/:slug` URL).
- **Loading splash continuation:** the Angular-side `LoadingSplashComponent` drives three discrete lifecycle stages so a slow synchronous tree render after a cold-boot blob download does not read as "stuck at 100%". Driven by a root-singleton `LoadingSplashService` exposing `kind: Signal<'jotjson' | 'blob' | null>`, `renderPending: Signal<boolean>`, and `progress: Signal<number | null>`. (1) **Bootstrap stage** (`kind='jotjson'`, `renderPending=false`): "Loading JotJSON..." with the bar visible, indeterminate. Shown until the first `NavigationStart` flips the kind. (2) **Download stage** (`kind='blob'`, `renderPending=false`): "Downloading JSON..." with the bar visible, determinate when the share-blob resolver streams progress fractions via `reportBlobProgress(loaded, total)`, indeterminate otherwise. (3) **Render-pending stage** (`kind=null`, `renderPending=true`): "Rendering tree..." with the bar **intentionally hidden** - no honest progress signal exists for the JSON.parse + CD pass that mounts `HomeComponent` and renders the tree, and a pinned bar would re-create the very "stuck at 100%" perception this stage exists to fix. Entered via `markBlobBytesComplete()`, called by the share-blob resolver when `BlobService` emits its synthetic `bytesComplete` event - i.e., when the body bytes have fully arrived but BEFORE the synchronous `JSON.parse` runs. (For multi-MB blobs, that parse can take seconds on the main thread; entering render-pending pre-parse is what prevents the bar pinning at 100% under "Downloading JSON..." through the parse window.) The `kind!=='blob'` guard in `markBlobBytesComplete` means in-app navs are no-ops (their `kind` is null after the `firstNavComplete` latch) and a defensive double-call cannot re-arm the timer. Cleared by `HomeComponent` calling `markBlobRenderComplete()` after first browser paint, deferred via `afterNextRender` plus a double-`requestAnimationFrame` (the established paint-barrier idiom in this repo, mirroring `afterFirstPaint()` in `HomeComponent` and `JsonTreeComponent`). The clear emits a `blob.coldBoot.firstPaint` telemetry event with a `durationMs` measurement covering the bytesComplete-to-paint gap (parse + activate + construct + CD + paint), raw value, no bucket dimension. The signal also resets when `NavigationStart` fires while `renderPending=true` (user navigated away mid-render), and defensively when `NavigationCancel/Error/Skipped` fires while `renderPending=true` (e.g., the resolver redirects to `/404` after a parse error that occurred AFTER bytesComplete fired); those paths emit no telemetry because the abandoned render is not a useful first-paint sample. The render-pending stage only fires on the cold-boot first-nav blob; `firstNavComplete` latches and prevents in-app `/` -> `/s/:slug` navs from re-showing the splash - those use the route progress bar instead (preserves prior-page context). `progress` resets to `null` on every `NavigationStart` (covers cancelled-then-restarted blob navs) and on the `kind=null` first-nav-settle transition (covers splash hide), so callers do not need to manage clears.
- **Route progress bar:** while any router navigation is in flight (resolver, lazy chunk, redirect), an 8px top-of-viewport bar (primary cyan with glow) appears, matching the splash bar visually so the handoff at first NavigationEnd is continuous. By default it animates in indeterminate mode (sliding stripes); when `LoadingSplashService.progress` is non-null - currently only the share-blob resolver streams a fraction - the bar flips to a smooth determinate fill (`transform: scaleX(var(--jot-progress, 0))`, 200ms ease-out, snapped under reduced motion). In-app navigations to `/s/:slug` from `/blobs` or `/history` go through the same resolver and get the determinate variant naturally; other in-app navs stay indeterminate. The bar is decorative (`aria-hidden`); the route change itself is what assistive tech announces. Tracking is set-based on router event ids so resolver-redirect-to-/404 sequences (where the original navigation cancels and a new one starts) keep the bar visible without flicker. The bar is suppressed while the loading splash is visible to avoid a double-rendered bar at the same position.
- **Determinate blob-fetch progress (X-Jotjson-Body-Length):** the `GET /api/blobs/{idOrSlug}` handler manually serializes the response and stamps `X-Jotjson-Body-Length: <utf8-byte-count>` on the response headers. Azure Front Door compresses `application/json` on the fly with `Transfer-Encoding: chunked`, which strips `Content-Length`, so Angular's `HttpEventType.DownloadProgress` events otherwise arrive with `total: undefined`. The custom header (which AFD passes through unchanged) gives the client an uncompressed total to drive the determinate progress bar. `BlobService.getWithProgress(idOrSlug)` consumes it: it memoizes the value on `ResponseHeader` (without emitting yet, to avoid a 0% bar flash), then attaches it to every `DownloadProgress` event. If the header is missing or unparseable, the client falls back to indeterminate with no regression. The resolver also emits a `blob.fetch.complete` telemetry event with a `determinateProgress: boolean` property so we can spot regressions if AFD configuration drifts at the edge fleet level.
- **Loading skeletons:** show pulsing placeholder blocks while API data loads (history list, blob fetch, rule sets). The editor + tree view render instantly from local state.
- **Error toasts:** non-blocking toast notifications (bottom-right, auto-dismiss after 5 seconds) for API errors, save failures, and network issues. Include a "Retry" action where applicable.
- **404 page:** friendly "Blob not found" page for invalid `/s/:id` links, with a CTA to go to the editor. Similarly, a generic 404 for unknown routes.
- **Offline banner:** persistent banner at the top of the page when network is unavailable (detected via `navigator.onLine` + service worker). Dismisses automatically when connectivity returns.
- **Empty states:** contextual illustrations + messages for:
  - History page with no entries: "No history yet - paste some JSON to get started."
  - No saved blobs: "You haven't saved any JSON blobs yet."
  - No formatting rule sets: "Create your first rule set to highlight JSON your way."
  - Search with no matches: "No matches found for '...'"
- **Validation error inline:** JSON parse errors appear as a red banner below the editor with the error message, line number, and column. The editor scrolls to and highlights the offending line.

### Preferences card (Profile page) - control conventions

This section locks the conventions used by the Preferences card on the Profile
page so new preferences stay visually and behaviorally consistent;
`src/app/features/profile/profile.component.{html,scss}` is the canonical
example.

**Row primitive:** every preference row is a `.pref-row` element rendered as
`display: grid; grid-template-columns: 1fr auto`. The label sits in column 1 as
a sibling `<span class="pref-label">`; the control sits in column 2. At
`max-width: 480px`, the row collapses to a single column with the control
flowing below the label.

**Slide-toggle labels are externalized:** a bare `<mat-slide-toggle>` with no
inner content and no `labelPosition` lives in column 2. Its visible label is a
`<span class="pref-label" id="...">` in column 1, and the toggle is wired via
`aria-labelledby`. Do not use the toggle's internal label; this avoids a
`::ng-deep .mdc-form-field` flex hack.

**Widget choice table:** use this picker to prevent future drift.

| Setting kind | Widget |
|---|---|
| Binary on/off | `mat-slide-toggle` (label externalized per the rule above) |
| Set membership / multi-select | `mat-checkbox` |
| Choose-one with 2-3 short options (each label at most 6 chars) | `mat-button-toggle-group` |
| Choose-one with 4+ options OR longer-label options | `mat-select` (inside `mat-form-field appearance="outline"`) |
| Numeric quantity | `mat-form-field` + `matInput type="number"` + `matTextSuffix` |
| Color | native `<input type="color">` + swatch + hex string (no Material widget exists for this) |

Use `.pref-form-field` on Material form-field controls in this card. The at
most 6 chars rule prevents button-toggle pills from wrapping and is why Theme,
Layout, Path-root, Search-scope, and Quota-strategy stay as `mat-select` while
Tab-size stays a button-toggle.

**Sub-groups:** child preferences that depend on a parent toggle are wrapped in
a `.pref-subgroup` block with an accent left border (`border-left: 2px solid
var(--mat-sys-primary)`). Nested rows and help lines work the same as outside;
specialized child layouts such as `.date-annotation-unit-grid` stay inside the
subgroup.

**Help text:** use a single `.pref-help-line` class. Always render it as a
`<p>` sibling immediately after its `.pref-row`. Never place help copy
inline-right of the control. Never use the now-removed `.pref-hint`,
`.pref-help`, `.pref-help--inline`, or `.group-help` classes.

Any new preference must follow these rules; any genuine exception must be
justified in the PR/commit message and considered for a spec update.

---

## Project Structure (Angular)

Representative layout (not exhaustive - only load-bearing directories are
listed):

```
src/
├── app/
│   ├── core/                    # Singleton services, guards, interceptors
│   │   ├── api/                 # HTTP services (BlobService, MeService, etc.)
│   │   ├── auth/                # MSAL config, auth guard, AuthService
│   │   ├── clipboard/           # ClipboardPollingService (M7a)
│   │   ├── interceptors/        # Auth token, error interceptors
│   │   ├── json/                # JsonParserService (jsonc-parser wrapper)
│   │   ├── preferences/         # PreferencesService, DraftService
│   │   ├── quota/               # QuotaNotificationService (M4b)
│   │   └── seo/                 # SeoService (OG / twitter / noindex tags)
│   ├── shared/                  # Reusable UI primitives
│   │   ├── components/
│   │   │   ├── app-header/      # Global chrome (brand + auth cluster)
│   │   │   ├── icon/            # Inline SVG icon set
│   │   │   ├── json-editor/     # Monaco editor wrapper
│   │   │   ├── json-tree/       # Recursive tree view
│   │   │   └── toolbar/         # Home page action cluster
│   │   ├── dialogs/
│   │   │   └── confirm-dialog/  # Reusable yes/no dialog
│   │   ├── directives/          # e.g., *jjSignedIn structural directive
│   │   └── pipes/
│   ├── features/
│   │   ├── home/                # Main editor + tree view page
│   │   │   ├── clipboard-banner/# First-time paste-permission banner (M7a)
│   │   │   └── status-bar/      # Bottom-of-page stats strip (M7m)
│   │   ├── blobs/               # /blobs blob list page (M4b)
│   │   ├── history/             # /history activity timeline (M5b)
│   │   ├── formatting-rules/    # /formatting-rules (future M6)
│   │   ├── not-found/           # /404 page (M4c)
│   │   ├── profile/             # /profile page
│   │   └── share/               # /s/:slug resolver (no component; routes through HomeComponent)
│   ├── app.component.ts
│   ├── app.routes.ts
│   └── app.config.ts
├── environments/
│   ├── environment.ts           # Local config (gitignored-equivalent)
│   ├── environment.prod.ts      # Build-time replacement for production
│   ├── environment.example.ts   # Template committed to the repo
│   └── environment.interface.ts # Shared type
├── generated/                   # Build-time artifacts (e.g., build-info.ts)
├── locale/                      # @angular/localize extracted messages (xlf)
├── styles/                      # Global SCSS (tokens, theme, base styles)
└── testing/                     # Shared test helpers (e.g., provideFakeAuth)
```

Static public assets (favicons, manifest, etc.) live at the repo-root
`public/` directory and are copied as-is by the Angular build (per
`angular.json` assets config).

---

## Azure Infrastructure (IaC - Bicep)

| Resource | SKU / Tier | Notes |
|---|---|---|
| Azure Static Web Apps | Standard | Hosts SPA + proxies to managed Functions. Upgraded from Free to Standard during M7e (apex custom-domain binding requires Standard). Standard also enables the Cosmos-via-managed-identity path planned in M7o (bring-your-own Functions). |
| Azure Functions | Consumption | Serverless API |
| Cosmos DB | Serverless | Database: `jotjson`. Containers + partition keys: `blobs` (`/ownerId`), `users` (`/id`), `history` (`/userId`), `rule-sets` (`/userId`). |
| Microsoft Entra External ID | Free (50k MAU) | Identity |
| Azure Blob Storage | Standard LRS | User avatars + export ZIP artifacts (SAS-linked, 1-hour TTL) |
| Azure Front Door | *(deferred post-v1)* | Add for WAF / advanced routing if needed |
| Azure Monitor / App Insights | Pay-as-you-go | Logging, telemetry |

### Cosmos DB authentication

The SWA deployment provisions a system-assigned managed identity on the Static
Web App and a `cosmosRoleAssignment.bicep` that grants Cosmos DB Built-in Data
Contributor at the database scope. However, **the SWA managed-Functions
runtime does not expose that managed identity to the Function process** -
`DefaultAzureCredential` cannot acquire tokens inside a managed-Function at
runtime. As a result, the API authenticates to Cosmos with a primary key
(`COSMOS_KEY` app setting) in production. The managed-identity + RBAC
machinery is retained in Bicep for the day JotJSON moves off managed Functions
(e.g., to a bring-your-own Function App or Container App), at which point the
key fallback can be removed. Local `func start` also uses `COSMOS_KEY`.

---

## CI/CD (GitHub Actions)

- **CI pipeline** - runs on every push and PR:
  - Lint, frontend tests, build (`ng build --configuration production`).
  - Azure Functions: lint, test, build.
- **CD pipeline** - deploys on merge to `main`:
  - Angular SPA -> Azure Static Web Apps (using the `azure/static-web-apps-deploy` action).
  - Azure Functions -> deployed as Static Web Apps managed functions (bundled with the SPA in a single deployment).
  - Staging slot for preview on PRs (Static Web Apps preview environments).
- **Infrastructure** - Bicep templates applied via a separate workflow on changes to `/infra` directory.
- **Workflow lint** - `actionlint` runs against `.github/workflows/` in CI.
- **Spec-pattern lint** - `scripts/check-spec-patterns.mjs` runs in CI's lint job and fails on known-fragile testing idioms (e.g. `spyOnProperty(navigator, 'clipboard', ...)` which silently passes on Windows headless Chrome but throws on the Linux runner). New rules are added as we encounter cross-platform test failures.

### Pre-v1 readiness review

Items to revisit before declaring v1 complete (deliberately deferred so they do not slow current development velocity):

- **PR-by-default for code changes.** Today, code changes can land directly on `main`. Decide whether v1 should require code changes to land via a PR with green CI before merging, with CD/workflow hotfixes remaining as the only sanctioned direct-to-`main` path. Rationale for deferring now: keeps iteration velocity high; CI on `push: main` still runs, just after merge.
- **Bundle size budget.** `angular.json` `maximumWarning` / `maximumError` were temporarily relaxed; tighten before launch.

---

## Testing strategy

JotJSON is layered: a static-analysis pass, two unit suites (frontend + Azure
Functions), and an in-browser integration layer for components whose real
runtime behavior cannot be faked cheaply (Monaco today; the same pattern
applies to anything else that depends on browser globals or external scripts).
Three additional layers are planned v1 gates: API integration against a
CI-only real Cosmos DB free-tier account (issue #63), anonymous Chromium
smoke e2e (issue #64), and accessibility smoke blocking on serious/critical
axe violations (issue #66). Cross-browser smoke (issue #65) and visual
regression (issue #67) are tracked as post-v1 follow-ups. Signed-in smoke
e2e (issue #68) is deferred indefinitely pending a dedicated Entra External
ID test tenant.

| Layer | In place? | Purpose |
|---|---|---|
| Static analysis | yes | TypeScript `tsc --noEmit`, ASCII gate, spec-pattern lint. |
| Unit (frontend) | yes | Component / service / pipe / pure logic; Monaco and other browser globals are stubbed. Co-located `*.spec.ts`. |
| Unit (api) | yes | Azure Functions handlers and shared modules; Cosmos and Blob clients are mocked. |
| Browser integration | yes | Real Monaco loaded once per suite via the project's loader. Verifies the loader, the asset path, and the editor's mount + value roundtrip with a real DOM. Lives alongside frontend unit specs but is named `*.integration.spec.ts`. |
| API integration | v1 gate (planned) | Functions + shared modules against a CI-only real Cosmos DB free-tier account (1000 RU/s + 25 GB free forever; per-run unique database name; secret-presence check skips fork PRs). Catches partition-key, query-shape, and continuation-token mistakes that mocks cannot. The `vnext-preview` Linux emulator is rejected as a harness due to acknowledged flakiness. Tracked in issue #63. |
| Smoke e2e (anonymous) | v1 gate (planned) | Playwright on critical anonymous user flows in Chromium, per-PR. Catches MSAL redirect, router lazy-load, service-worker, and CSP regressions that unit + browser-integration cannot. Tracked in issue #64. |
| Smoke e2e (signed-in) | deferred | Same harness as anonymous smoke, but covers blob CRUD, share lifecycle, profile round-trip, and MSAL silent-token refresh. Requires an Entra External ID test tenant + ROPC users in CI; tenant setup is currently out of scope. Tracked in issue #68. |
| Cross-browser smoke | post-v1 | Playwright matrix on Firefox + WebKit, run nightly. Catches engine-specific issues. (WebKit on Linux is not Safari; iOS-Safari still needs manual verification.) Deferred post-v1 due to engine-flake risk and zero historical engine-specific shipped bugs. Tracked in issue #65. |
| Accessibility smoke | v1 gate (planned) | `@axe-core/playwright` invoked from each smoke flow, blocking on `serious` + `critical` impact only; pre-existing violations are allow-listed with dated review-by comments. Backs the WCAG 2.1 AA commitment in the Accessibility section (axe-green is necessary but not sufficient for WCAG-green - keyboard-only nav, screen-reader announcements, and dynamic focus order remain manual concerns). Tracked in issue #66. |
| Visual regression | post-v1 | Pixel-diff of representative screens against a baseline. Post-v1 unless visual bugs become recurring. Tracked in issue #67. |

What this layer model deliberately does *not* claim:

- The **browser integration** layer does not prove worker correctness. The Monaco JSON worker spawns from a runtime-built blob URL; verifying that requires worker-specific assertions whose value at this layer is bounded. Worker-shaped bugs are expected to surface at the smoke-e2e layer once that lands as a v1 gate.
- **Unit (api)** uses mocked Cosmos / Blob clients. Until the API integration layer lands as a v1 gate, partition-key bugs, indexing-policy issues, and continuation-token correctness are not covered by CI.

Layer names above are runner-neutral so this model survives runner migrations
(see issue #47 - test-runner migration).

---

## Telemetry & Logging

JotJSON uses **Azure Application Insights** for both the SPA and the
Azure Functions backend. The resource is provisioned in
`infra/modules/appInsights.bicep` and shared between the two.

### Connection-string flow

- **Functions**: connection string injected as an app setting
  (`APPLICATIONINSIGHTS_CONNECTION_STRING`) by Bicep. The Functions
  runtime auto-instruments via `host.json`, and the manual
  `TelemetryClient` in `api/src/shared/telemetry.ts` reads the same
  app setting on first use.
- **SPA**: connection string is baked into `environment.prod.ts` at CI
  build time (in `ci.yml`'s `web` job on push-to-main, or inline in
  `cd.yml` on `workflow_dispatch`) from the
  `APP_INSIGHTS_CONNECTION_STRING` GitHub secret. Empty value ->
  telemetry disabled in that build (no SDK chunk loaded). The bake
  step intentionally does NOT fail-closed when the App Insights
  secret is empty, so a deploy still succeeds without telemetry.

### What we collect (SPA)

Manual instrumentation, driven through `core/telemetry/LoggerService`:

- **Page views** - emitted by `route-tracker` on `NavigationEnd`, using
  the matched Angular route template (e.g. `/s/:slug`, `/blobs`),
  never the raw URL. Auto route tracking is **off**.
- **Exceptions** - captured by `TelemetryErrorHandler` (registered as
  Angular `ErrorHandler`). Every error goes through `normalizeError`,
  which returns a strict whitelist (`status/method/pathTemplate/
  backendCode` for HTTP, `name/message/stack` for `Error`, redacted
  and truncated). Auto exception tracking is **off** to avoid
  duplicates.
- **Traces** - structured warnings from migrated `console.warn` sites
  (`api.error`, `home.save.failed`, `share.delete.failed`, etc.). All
  message IDs come from a frozen literal-union in
  `telemetry-message-ids.ts` so typos fail at compile time.
- **Product events** - emitted with `LoggerService.event(...)` and
  documented in `telemetry-message-ids.ts`. Preference changes use the
  `pref.changed` token from the `PreferencesService` chokepoint: keys
  are schema-derived closed enums, booleans are string dimensions,
  numeric values use bucket dimensions plus raw numeric measurements,
  and colors send only a coarse bucket plus `isDefault` (never raw hex).
- **Core Web Vitals** - the SPA emits a `webVitals` event on `pagehide`
  with LCP, INP, and CLS measurements. The `web-vitals` package is
  lazily loaded in a separate post-boot chunk, so it stays out of the
  initial bundle.
- **Dependencies (XHR/fetch)** - **on**, for SPA <-> Functions
  correlation. URLs are sanitized in a telemetry initializer (query
  string and fragment stripped). Ajax error response bodies are **off**
  (`enableAjaxErrorStatusText: false`).
- **Browser perf timings** - on (no PII).

### What we collect (Functions)

Manual instrumentation via the `applicationinsights` `TelemetryClient`
in `api/src/shared/telemetry.ts` running in the worker process. The
Functions host **also** auto-instruments `requests` / `dependencies`
/ `exceptions`; the manual SDK is dedicated to explicit
`customEvents`. `useGlobalProviders: false` keeps the manual client
isolated from any global OpenTelemetry providers the host may
register. The client is lazily constructed on the first `trackEvent`
call and warns once (then becomes a no-op) when the connection
string is missing, so missing config never throws into a request
path.

- **Auth lifecycle** (`api/src/shared/auth.ts`):
  - `auth.tokenAccepted` - properties `{authMode: 'required' |
    'optional'}`. One emit per validated bearer.
  - `auth.tokenRejected` - properties `{reason: 'missing_bearer' |
    'malformed' | 'invalid_signature' | 'expired' | 'wrong_audience'
    | 'wrong_issuer' | 'no_kid', authMode: 'required'}`. One emit
    per rejected bearer. `optional`-mode requests never emit a
    rejection; bad-but-optional tokens fall through as anonymous.
- **Authorization** (`api/src/shared/http.ts` `forbidden()` helper):
  - `access.forbidden` - properties `{resource: 'blob' | 'ruleSet',
    authMode: 'required'}`. One emit per 403 response from the
    helper.
- **Quotas** (`api/src/shared/http.ts` `quotaExceeded()` helper):
  - `quota.exceeded` - properties `{resource: 'blob' | 'ruleSet',
    authMode: 'required', via: 'create' | 'clone'}`, measurements
    `{count, limit}`. `count` is the user's current count (raw, not
    clamped to `limit`) so quota reductions and historical overages
    remain queryable; `limit` is the configured ceiling. One emit
    per 409 response from the helper. The blob auto-FIFO path
    (`postBlob` with `strategy = 'auto_fifo'`) silently evicts the
    oldest blob and does **not** emit; only the manual-strategy 409
    path emits.

All backend events run after `requireAuth`, so `authMode` reflects
which auth gate the call passed (or, for `auth.tokenRejected`, was
rejected by). No user content, blob bodies, slugs, rule-set ids, or
free-form strings are emitted - only closed-enum dimensions and
bounded numeric measurements.

See `docs/telemetry.md` for KQL examples and the routing details
between the manual `customEvents` pipeline and the host's
auto-instrumented `requests` / `dependencies` / `exceptions`
pipelines.

### What we deliberately do NOT collect

- **Editor or clipboard content.** The `LoggerService` API does not
  accept arbitrary user text, only structured `messageId + props` and
  normalized errors.
- **URL query strings or fragments.** History search (`q`,
  `continuationToken`, `from`, `to`) and slug-bearing share links
  never reach App Insights.
- **HTTP request or response bodies.**
- **Authorization headers.** Redacted in the privacy initializer as
  defense in depth.
- **Cookies.** `disableCookiesUsage: true`.
- **Email, UPN, display name, or any free-form user identifier.** The
  only identifier we send is the Entra `oid` via
  `setAuthenticatedUserContext`. `redactPii` scrubs anything that looks
  like an email or UPN out of free-text fields (Error messages, MSAL
  log lines, stack frames).
- **Click analytics.** The clickanalytics plugin is not loaded.

### Bootstrap-failure path

If `bootstrapApplication` rejects before Angular comes up, `main.ts`
writes a sanitized record to `sessionStorage['jotjson.bootErr']`.
`LoggerService.connect()` reads, clears, and replays it as a
`boot.failed` exception once telemetry comes online.

### MSAL log forwarding

`createMsalInstance()` runs as a factory before Angular DI. It cannot
inject `LoggerService` directly, so it publishes through a
module-scoped `msalBridge` that buffers the most recent error-level
messages. `LoggerService` attaches a consumer in its constructor; the
buffer is drained on attach. Only `LogLevel.Error` messages are
forwarded; PII messages are dropped at the source by MSAL.

### Sampling

- Functions: host-runtime adaptive sampling for auto-instrumented
  `requests` / `dependencies` / `exceptions`. Manual `trackEvent`
  calls (auth / access / quota events from
  `api/src/shared/telemetry.ts`) are **unsampled** - the
  `TelemetryClient` does not set a sampling percentage, so every
  call ships.
- SPA: 100% in v1.

### Sourcemaps

Production builds emit visible sourcemaps for both scripts and
styles (`"sourceMap": true` on the production configuration in
`angular.json`, equivalent to
`{ scripts: true, styles: true, vendor: false, hidden: false }`).
JotJSON-authored TypeScript and SCSS map cleanly back to source;
Angular framework / `node_modules` internals are skipped to keep
artifact size in check. Each emitted JS chunk ends with a
`//# sourceMappingURL=...` URL comment and each CSS bundle ends
with the equivalent `/*# sourceMappingURL=... */`.

Maps reach two destinations on every push-to-main:

1. **Static Web Apps** - `.js.map` / `.css.map` files are part of
   the `web-dist` artifact CI hands to CD, so they ship to SWA
   alongside their `.js` / `.css` siblings. DevTools picks them up
   automatically on any browser session against
   `https://jotjson.com/`. JotJSON is open source on GitHub;
   shipping public maps adds no new disclosure.
2. **Azure Blob Storage container `sourcemaps`** - CI uploads
   every `*.map` file to a dedicated container in the existing
   environment storage account, using the existing federated
   workload identity (`secrets.AZURE_CLIENT_ID` /
   `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID`) plus a new
   `secrets.AZURE_STORAGE_ACCOUNT`. The container is wired into
   the Application Insights resource via the **Source Map** blade
   in the Azure portal (`Application Insights -> Settings ->
   Source Map -> Add new storage account configuration`); the
   portal then de-symbolicates frames in the Failures blade. The
   manual-deploy path in `cd.yml` mirrors the same upload step so
   `workflow_dispatch` emergency redeploys keep the container in
   sync.

The AI source-map binding is **not Bicep-modeled** today: the
`Microsoft.Insights/components` schema does not expose the JS
source-map storage configuration. It is a one-time portal step
per environment. If the Application Insights component is ever
torn down and recreated, re-run the portal step; until that
happens, AI traces temporarily go back to minified - recoverable,
no data loss.

The sourcemap upload step in CI runs **after** `Upload web bundle`
(so an upload failure does not block the artifact upload itself
and CD can be re-run from a saved artifact) but is **not**
`continue-on-error: true` - failures fail the run loudly, which
prevents CD's `workflow_run`-on-success trigger from firing and
shipping a deploy with broken AI symbolication. `--overwrite true`
on `az storage blob upload-batch` accommodates Angular's
`outputHashing: all` (vendor chunks reuse hashes across builds).

The Angular service worker glob list does not over-match `.map`
files: `globToRegex` in
`@angular/service-worker/fesm2022/config.mjs` wraps every pattern
as `'^' + ... + '$'` (lines 178/183), so `/*.js` becomes
`^/[^/]*\.js$` and excludes `main.js.map`. No `ngsw-config.json`
change is needed.

### Local development

- `environment.appInsightsConnectionString` is empty in
  `environment.example.ts`/`environment.ts`.
- `LoggerService` mirrors all calls to `console.*` regardless, so
  DevTools shows the full log in dev.
- `TelemetryService.connect()` short-circuits to `disabled` on empty
  connection string; the `applicationinsights-web` chunk is not
  fetched.

### CSP allowlist (for future hardening)

If/when a Content Security Policy is enforced, App Insights ingestion
needs:

- `*.in.applicationinsights.azure.com` (telemetry ingestion)
- `*.livediagnostics.monitor.azure.com` (live metrics)
- `js.monitor.azure.com` (CDN, only if we ever switch the SDK to a
  CDN load - we currently bundle it via npm)

### Data residency

The App Insights resource is currently provisioned in **West US 2**.
EU users would need a regional resource - out of scope for v1.

---

## Versioning

JotJSON uses [semver](https://semver.org/) for `package.json` `version`. The
build script surfaces the version + a per-deploy build counter + git SHA in
telemetry, and version + SHA in the status-bar badge.

### Manual SemVer + automatic build counter

Two identifiers ship together in the generated `BUILD_INFO` (see
`scripts/write-build-info.mjs` and `src/generated/build-info.ts`):

- **`version`** - manual, comes from `package.json`. Bumped explicitly
  by a contributor when the change warrants a SemVer move per the bump
  rules below. Stays put for refactors, telemetry plumbing, doc edits,
  CI changes, etc. The `package.json` SemVer is **not** an
  every-deploy identifier.
- **`buildNumber`** - automatic, comes from `git rev-list --count HEAD`
  at build time. Monotonically non-decreasing on `main`. Used as a
  human-orderable per-deploy identifier in telemetry and as a
  decoration in the status-bar tooltip.
- **`sha`** - automatic, comes from `git rev-parse HEAD`. The precise
  per-deploy identifier; the short form is shown in the visible
  status-bar row.

The visible status-bar row shows `v{version} - {shortSha}` exactly as
today (the short SHA already gives at-a-glance per-deploy uniqueness).
The build counter appears only in the tooltip, and only on shipped
builds (`sha !== 'dev'` and `buildNumber !== 'unknown'`).

### Build counter fallback

When `git rev-list --count HEAD` cannot be evaluated reliably -
typically a shallow CI checkout, or git not on the PATH - the build
script emits the sentinel `buildNumber: 'unknown'` rather than a
misleading `'0'` or a truncated count. CI's `web` job runs a
post-build assertion that fails the workflow if the shipped artifact
contains `'unknown'`, so prod artifacts never ship under the
sentinel. Local dev builds and non-artifact CI jobs (api, lint,
infra) may legitimately emit `'unknown'`.

### Telemetry stamping

Both `appVersion` and `buildNumber` are stamped on `app.boot` and
`webVitals` events as separate string fields - not a combined string
- so triage queries can filter by either dimension. The
build-identity carve-out in
`src/app/core/telemetry/telemetry-message-ids.ts` exempts these
dimensions from the closed-enum cardinality rule.

### SemVer bump rules

Every plan and every commit must record a SemVer bump decision
(patch / minor / major / none). See `AGENTS.md` Section 7
(Definition of Done) and Section 11 (Critical Thinking & Proactive
Feedback / Planning) for the gate. Use these rules:

- **Patch** (`x.y.Z+1`): user-visible bug fix that wasn't a feature
  or a breaking change. Edit `package.json` in the same commit.
- **Minor** (`x.Y+1.0`): new user-visible feature, backwards
  compatible. Edit `package.json` in the same commit.
- **Major** (`X+1.0.0`): breaking change, or the v1.0.0 cutover.
  This is a user call - surface to the user before bumping.

  **Pre-1.0 carve-out**: while the project is pre-1.0, follow
  standard SemVer convention and apply breaking changes as **minor**
  bumps instead. The major-on-breaking rule kicks in only once we
  cut 1.0. Pre-1.0 breaking changes still require an explicit
  history entry calling out the wire-level change so deploys can be
  tracked.
- **Multi-wave milestones**: when a milestone lands as a series of
  waves in separate commits (e.g., M7g shipped via 3a, 3b, 3c, 3d,
  3e, 3f, then M7g-final), each individual wave bumps **patch**
  regardless of whether its content would, in isolation, warrant a
  minor bump. Reserve a single SemVer bump (typically minor, or
  whatever the aggregate close-out content warrants) for the
  milestone-completion commit. This keeps mid-milestone commits
  versioning-cheap while still emitting one user-visible "this
  milestone shipped" signal at the end. The milestone must be
  defined in advance (in this spec's milestone list or a session
  plan) for the rule to apply - ad-hoc retroactive grouping does
  not qualify. Example: M7g shipped via 3c -> 0.14.1, 3d -> 0.14.2,
  3e -> 0.14.3, 3f -> 0.14.4 (all patches), then M7g-final -> 0.15.0
  (minor).
- **No bump**: refactors, tests, docs, deps, build/CI infrastructure,
  telemetry plumbing, dev-only changes - anything that doesn't alter
  user-visible behavior. State "no bump" in the response so the
  decision is on the record.

The build counter and the SHA already give per-deploy resolution, so
there is no need to bump SemVer just to mark a deploy.

### Schema evolution

Cosmos containers are schema-less; documents written under one code
rev coexist with newer-shape documents in the same container. JotJSON
handles schema changes per the rules below rather than running an
automated migration on deploy.

Three change shapes:

- **Additive** (new optional field with a default). Add the default
  on the read path (`normalizeStoredPreferences` for user prefs, the
  equivalent normalizer for other docs). No migration needed. Old
  docs read as the default until the next write.

- **Rename or reshape**. Default playbook:
  1. Land the rename on the wire and in storage; new writes emit
     only the canonical shape.
  2. Add a *read-side fold* in the appropriate normalizer that
     translates the legacy shape into the canonical shape. Tag the
     fold with a JSDoc note pointing back to this section and the
     issue/milestone that introduced it.
  3. Make the fold *self-healing on next write* where convenient
     (e.g., the rule-set delete path already re-saves the user
     doc; opportunistic write-back on read is acceptable but not
     required by default - new writes naturally emit the canonical
     shape).
  4. Add a one-shot operator script under
     `api/scripts/migrate-<topic>.mjs` (template:
     `api/scripts/migrate-example.mjs`) that reads every affected
     doc and re-saves any straggler in the legacy shape. The
     operator runs it once after the deploy that lands the rename.
     Optional for low-impact renames where the fold + lazy heal is
     sufficient and the worst-case user impact is acceptable.
  5. Track the read-side fold as a deferred item in the milestone
     where it landed. Remove it in a follow-up once stored data is
     verified clean (or once the impact of any remaining stragglers
     is judged acceptable). Removing the fold means dropping any
     synthesis of canonical-from-legacy; the *strip* of legacy keys
     stays so they never round-trip into wire validation.

- **Removal**. Treat as a rename to nothing: ship a read-side strip
  that drops the field, optionally a one-shot script, then remove
  the strip once Cosmos is clean.

Out of scope (for v1):

- **`schemaVersion` field on stored docs.** Useful when multiple
  developers ship migrations independently and at a scale where
  ad-hoc handling becomes error-prone. Not yet.
- **Automated cloud-migration runner on deploy.** SWA managed
  Functions have no clean pre-traffic hook and Cosmos serverless
  RU spikes during a backfill can throttle live traffic. Not yet.

### History

- **Initial**: `0.5.0` (set when M7n landed, acknowledging substantial
  pre-V1 development).
- **0.6.0**: M7r title suggester (wand button) - new user-visible
  feature on the home toolbar.
- **0.7.0**: Pair-rule formatting - `kind: simple|pair` rules with
  key/value AND matching and value predicates.
- **0.7.1**: Test Header Content preset - adds `has_content` /
  `lacks_content` value predicates for null-or-empty highlighting.
- **0.7.2**: M7t prose-preserving in-tree extraction - tree extract on
  a string containing prose around embedded JSON wraps the result in
  `{ prefix?, json, suffix? }` (single block) or
  `{ prefix?, json1, between_1_and_2?, json2, ..., suffix? }`
  (multi-block) so surrounding prose is preserved.
- **0.7.3**: Tree extract auto-expand - after in-tree extraction
  replaces a string value with the new wrapper, the just-extracted
  node auto-expands by one level so the structure is immediately
  visible without an extra click.
- **0.7.4**: Alt-modifier copy-as-escaped-JSON now honored on tree row
  double-click and the row's "Copy value" context-menu item, matching the
  toolbar Copy button's Alt+click affordance.
- **0.8.0**: Decoded view toggle - per-row pill on string leaves whose
  JSON-escaped form contains escape-worthy characters. Toggles the row's
  rendering between the JSON-escaped single-line form and the decoded
  multi-line form; display-only (does not affect copy, search, or
  persistence).
- **0.9.0**: Additive style projection + preset polish - the formatting
  rules engine now accumulates `icon` set-union across overlapping rules
  (deduped, in first-occurrence order) while keeping the other inline
  styles (color, bold, italic, underline) on last-wins semantics, so a
  row can simultaneously carry e.g. a red background, an error icon,
  and bold text without one rule clobbering the others. Built-in
  presets updated to take advantage: every Error Detection rule now
  carries the `error` icon by default; the three `has_content`
  Test Header Content rules carry the `warning` icon (lacks_content
  unchanged). Two error-detection match-type refinements ship in the
  same release: `err` switches from `contains` to `exact` (the embedded
  forms are already covered by the `error` rule, and case-insensitive
  contains-match was hitting English noise like "merry" / "where"),
  and `fault` switches from `contains` to `starts_with` (so the very
  common word "default" no longer triggers it).
- **0.10.0**: Beacon Rules surfacing UI - a "beacon" is any formatting
  rule that projects an icon. Beacons surface in three places without
  any new rule schema: (a) on each tree row, the engine-projected key
  and value icons render inline next to the key/value (existing
  behavior, kept); (b) collapsed container rows whose subtree contains
  hidden beacons render an extra ancestor-badge per icon-type next to
  the chevron - clicking a badge expands the path to (and selects) the
  first hidden match for that icon; (c) a new `<jj-toolbar-beacon-pills>`
  segment between the pane-layout group and the divider in the toolbar
  shows one pill per icon-bucket with at least one match in the tree -
  click cycles forward through the matches in pre-order (depth-first)
  and Shift+click cycles backward; the count chip appears only when the
  bucket has 2+ matches. Per-icon cursors are kept in component-local
  state and clamp on bucket shrink. Cross-pane navigation routes
  through a new `BeaconNavigationService` (root-provided): pill / badge
  clicks emit jump intents, and `HomeComponent` dispatches them to the
  tree or to Monaco based on `paneVisibility()` plus a tracked
  `lastActivePane()` (updated on tree pointerdown/selection and on
  Monaco cursor moves). Rule editor gains an inline hint near the icon
  picker explaining the beacon trigger. Telemetry: `beacons.evaluated`
  (per-recompute, skipped when nothing matched), `beacons.badge.clicked`,
  `beacons.pill.clicked`, `beacons.crossPane.dispatched` - all
  closed-enum props only (icon, direction, target, paneVisibility,
  source, plus bounded numeric measurements; no paths, no key/value
  content).
- **0.10.1**: Beacon pill double-count fix - `buildBeaconIndex` now
  dedupes the per-node icon set before populating `matchesByIcon`, so
  pair rules (which project the same icon onto both `keyStyle.icons`
  and `valueStyle.icons`) no longer cause a single matched row to be
  counted twice in the toolbar pill count chip. Inline icons and
  ancestor badges were unaffected (the descendant Set already
  deduped); only pill counts over-reported.
- **0.11.0**: Cosmos etag-by-default - every Cosmos `replace` in the
  API workspace now goes through the shared
  `replaceWithIfMatch` helper in `api/src/shared/cosmos.ts`, which
  combines a client-facing `version` bump with Cosmos's internal
  `_etag` `IfMatch` precondition. `lint:prod-patterns` enforces this
  structurally: `.item(...).replace(...)` outside the helper and
  `.upsert(...)` anywhere in `api/src/` are now lint failures.
  `UserDocument` becomes a `VersionedDocument` (additive `version`
  field, defaulted to `1` on read for legacy docs). The
  `upsertUser` shared helper is replaced with
  `createUser` / `replaceUser`. `POST /api/me` now honors the 409
  contract for racing first-seed POSTs by relying on Cosmos
  `items.create()` instead of upsert. **Breaking wire change**:
  `PUT /api/me/preferences` now requires `If-Match: "<version>"`;
  missing/malformed -> 400, no user doc seeded -> 404, stale
  version -> 412. `GET /api/me`, `POST /api/me`, and successful
  `PUT /api/me/preferences` responses carry a strong `ETag` header.
  The frontend `PreferencesService` threads etags end-to-end,
  serializes in-flight writes (at most one PUT in flight; queued
  tail re-fires with the fresh etag on response), and surfaces a
  "Preferences were changed in another window" snackbar via a new
  `PreferencesNotificationService` on 412. Pre-1.0 carve-out
  applies (breaking change shipped as minor; see Versioning).
- **0.12.0**: M7g-3a app-shell accessibility foundations - app-header
  gains a "Skip to main content" link (visually hidden until keyboard
  focus, then pops to the top-left of the viewport) and a
  `<nav aria-label="Primary">` landmark wrapping the auth-side route
  links. Every route now exposes `<main id="main-content"
  tabindex="-1">` plus an `<h1>` so the skip-link target works
  everywhere and screen readers always have a top-level heading to
  announce. A new `RouteFocusService` (root singleton) moves
  programmatic focus to `<main>` on every router `NavigationEnd`
  after the initial bootstrap navigation, so screen-reader and
  keyboard users hear / start from the new page on every in-app
  transition. Audit tooling (axe-core inside Karma, the
  `*.a11y.spec.ts` convention, the `src/testing/a11y.ts` harness with
  WCAG-AA-only `critical` + `serious` strict gating) landed in the
  same milestone and gates the foundations against regression. Later
  M7g waves (3b tree, 3c Monaco, 3d contrast, 3e focus polish,
  3f reduced-motion) follow under their own plan-and-approve cycles.
- **0.13.0**: M7l responsive layout - on viewports narrower than
  768px the editor/tree split now collapses to a single visible pane
  rather than the previously-spec'd "stacked-both" layout. When the
  persisted `paneVisibility` is `both`, the tree pane renders by
  default (the app at narrow widths is primarily for *viewing* JSON;
  Monaco editing at <= 360px is impractical). Persisted single-pane
  choices (`editor-only` or `tree-only`) are honored. The toolbar's
  segmented control collapses to a 2-state toggle (the two `both-*`
  segments hide via SCSS); the persisted `paneVisibility` is **never**
  mutated by the override, so resizing back above 768px immediately
  restores the user's stored choice (including `both`). The status bar
  also collapses to a single-line summary keeping only Lines, Size,
  and the Mode badge; Chars, cursor, nodes, depth, object/array
  counts, and the build/version badge are hidden. A new
  `createNarrowViewportSignal()` helper at `src/app/core/layout/`
  wraps `window.matchMedia('(max-width: 767.98px)')` with the same
  no-window fallback pattern used by `PreferencesService` for
  `prefers-color-scheme`. All four behavioral consumers in
  `HomeComponent` (`paneLayout`, `splitStyle`, `dispatchBeaconJump`,
  Ctrl+F tree-search guard) read an `effectivePaneVisibility`
  computed that overrides the persisted value while narrow,
  guaranteeing beacon clicks never route to the hidden editor and
  the highlighted toolbar segment is always visible. The splitter
  pointer-down handler also bails when effective visibility is not
  `both`, both at entry and inside the move closure to handle
  mid-drag viewport resizes.
- **0.13.1**: Splash polish - cover the prerendered server-skeleton on
  cold boot so the bare-bones SEO HTML never flashes between the
  prerender unmount and Angular bootstrap; restore the SEO `<h1>` mark
  to the prerendered shell so search-engine crawlers always see a
  top-level heading on the share-blob route.
- **0.14.0**: M7g-3b json-tree WAI-ARIA Tree pattern (audit findings
  F2.1-F2.3). Each `<mat-nested-tree-node>` now carries the full tree
  ARIA contract -- `role="treeitem"` (CDK default), `aria-level`,
  `aria-posinset`, `aria-setsize`, and (for containers) `aria-expanded`
  -- with a roving `tabindex` so exactly one row is in the Tab order
  at a time. `<mat-tree>` gets an `aria-label` (`@@tree.aria`,
  "JSON tree"); `.tree-row` and `.tree-row--close` become
  `role="presentation"` (visual chrome, not the tree node);
  `.tree-children` carries `role="group"`. Keyboard navigation lands
  per the WAI-ARIA Tree pattern: Up/Down moves between visible rows,
  Home/End jumps to first/last visible, Right expands a collapsed
  container or moves to the first child of an expanded container,
  Left collapses an expanded container or moves to the parent,
  Enter/Space selects the focused row, Shift+F10 / ContextMenu opens
  the row context menu via the existing `openContextMenuAt`
  hidden-anchor path. A new `focusedPath` signal drives roving
  tabindex independently of `selectedPath` (selection and focus stay
  separate); a single lifecycle effect handles initial focus, hidden-
  focus recovery on ancestor collapse, and reset-to-first-visible on
  JSON re-parse. Pointer clicks update both signals. Search-input
  Enter / Shift+Enter handoff updates `focusedPath` silently so
  repeated cycling stays in the search input. Type-ahead deferred to
  post-v1 (issue #108). Wave 3b also drops a structural `*.a11y.spec.ts` for
  the tree (role chain + roving-tabindex assertions); the strict axe
  scan is deferred to M7g-3d alongside the broader contrast
  remediation.
- **0.14.1**: M7g-3c Monaco editor accessibility options (audit
  finding F3.1). `JsonEditorComponent.ngAfterViewInit` now passes
  explicit `accessibilitySupport: 'auto'` and `ariaLabel: 'JSON
  editor'` (i18n message `@@editor.aria`) to
  `monaco.editor.create()`, threading the label through to
  Monaco's screen-reader-content element. Three new specs in
  `json-editor.component.integration.spec.ts` cover the raw
  options + the label rendered on the screen-reader-content
  element + the `aria-label` on the editor textarea. Out of
  scope (deferred): an in-Monaco axe scan of the editor's
  internal DOM, and the `accessibilityHelp` action registration.
- **0.14.2**: M7g-3d light-theme contrast remediation (audit
  findings F4.1, F4.2). Adds the `--brand-color-on-surface` token
  so the brand mark uses cyan in dark mode and `#006978` on light
  without changing the primary palette token. Theme-aware tree
  palette (`--tree-string`, `--tree-number`, `--tree-boolean`,
  `--tree-muted`) clearing AA on both themes including the count
  badge and type badge. Breadcrumb muted text + icons raised to
  AA; matched / current chip pairs added. New strict breadcrumb
  axe spec; re-enabled the strict tree axe scan in dark and
  light; added app-shell strict gates in dark and light; added a
  header light-theme strict gate.
- **0.14.3**: M7g-3e focus polish + offline-pill announcement
  (audit finding F5.2). Rule-editor `pillState()` switch wrapped
  in a persistent `role="status" aria-live="polite"` region so
  saved / saved-offline / queued / error transitions are
  announced to screen readers. Delete-confirm focus-fallback
  pattern (next-row, fallback to parent with `tabindex="-1"`)
  wired into the `MatDialogRef.afterClosed()` handlers in
  blobs/history/home. Quota-notification dialogs return focus to
  `#main-content`. The `CloseMatMenuOnWindowBlurDirective`
  blur-close path got automated focus-return spec coverage
  (manual route-level verification of focus restoration is
  deferred to the manual-checks plan). Five new strict overlay
  axe specs co-located per dialog host.
- **0.14.4**: M7g-3f reduced-motion sweep + lint gate (audit
  finding F6.1). Per-file `prefers-reduced-motion: reduce` motion
  guards across eight SCSS files (`formatting-rules`,
  `rule-sets-toolbar`, `status-bar`, `rule-preview`, `blobs`,
  `history`, `toolbar`, `route-progress-bar`). One allow-pragma
  on `.route-progress-bar__stripe--primary`'s opacity pulse
  (RDP / OS animation-off forces `prefers-reduced-motion: reduce`
  and a static bar would look frozen; full reasoning recorded in
  the accessibility memory cited from this commit). New
  `scripts/check-reduced-motion.mjs` lint gate (nesting-aware,
  pragma-aware, scans `transition:` / `animation:` / `@keyframes`
  in tracked + untracked SCSS files), wired into `npm run
  lint:all` via the new `npm run lint:reduced-motion` script.
- **0.14.5**: Issue #109 - tree-row double-click semantics split by
  node type. Container rows (`object` / `array` with children) now
  toggle expansion on dblclick instead of copying their pretty-printed
  JSON; primitive (leaf) rows still copy. Empty `{}` / `[]` are a
  no-op. Alt is ignored on container dblclick (Alt+dblclick on a
  primitive still emits the JSON-string-literal variant). The
  right-click "Copy value" context-menu item remains the canonical way
  to copy a container's serialized form. New
  `tree.row.doubleClickToggle` telemetry event with
  `{ action: 'expand' | 'collapse' }` (post-toggle state); the
  existing `tree.row.doubleClickCopyValue` event now fires only for
  primitive rows. The chevron-button toggle path is intentionally
  uninstrumented for parity with pre-issue-#109 behavior.
- **0.14.6**: Keyboard copy shortcut for the tree view. Ctrl+C / Cmd+C
  with a tree row focused copies the focused row's value to the
  clipboard with the same extraction semantics as the right-click
  Copy value action (raw text for primitives, pretty-printed JSON for
  containers). Works on leaves, containers, and empty containers
  (`{}` / `[]`) alike - "parent or leaf" parity per the user's
  request. Expansion state is never altered by the shortcut. Strict
  modifier gate: Ctrl+Shift+C (devtools) and Ctrl+Alt+C (AltGr
  layouts) are intentional no-ops. New `tree.keyboard.copyValue`
  telemetry event with `{ escaped: false }`.
- **0.14.7**: MSAL silent token refresh fix - relax `X-Frame-Options`
  from `DENY` to `SAMEORIGIN` and the report-only CSP `frame-ancestors`
  from `'none'` to `'self'`. MSAL's silent-refresh flow loads a hidden
  iframe at the IdP's `/authorize?prompt=none`, which 302s back to
  `https://jotjson.com/#code=...` so MSAL can read the auth code from
  the fragment and exchange it for a fresh access token. `DENY` blocks
  that final same-origin iframe navigation, MSAL throws
  `InteractionRequiredAuthError`, the auth interceptor maps it to an
  unauthenticated request, and the caller gets a 401 once the cached
  access token expires (~1h). Symptom: signed-in users intermittently
  see 401s on `/api/me`, `/api/blobs`, `/api/history` etc. on hard
  refresh while still seeing their profile pill in the toolbar (which
  is hydrated from the MSAL account cache, separate from the access
  token). `SAMEORIGIN` / `'self'` still block third-party clickjacking
  (the actual threat model `X-Frame-Options` addresses); the only
  protection removed is "jotjson.com iframing itself," which is
  exactly what MSAL silent refresh legitimately does. No client code
  change; pure SWA-config edit.
- **0.15.0**: Status-bar tree-stat clarity + new Comments stat
  (issue + PR #104). Tree-stat span labels rename to the literal
  user suggestions - Total Nodes, Max Depth, Objects, Arrays - and
  every span gets a `title=` tooltip explaining the metric (the
  build-info badge precedent). A new content-aware Comments stat
  surfaces comment count whenever the document parsed
  successfully and contains `//` or `/* */` comments, regardless
  of editor mode. Counting moves into `harvestComments` at parse
  time (extractCommentBody only trims whitespace, so the joined
  CommentBundle string cannot reliably be counted) and is exposed
  as `commentCount` on `JsonParseResult`. Visibility mirrors
  `treeStats()` gating exactly so a parse-failed document does
  not render Comments alongside placeholder dashes. i18n message
  IDs stay stable per AGENTS.md S4 - only source text changes.
- **0.15.1**: Status-bar Chars stat made meaningful (issue + PR
  #103). Before the change Chars (UTF-16 source length) and Size
  (UTF-8 source bytes) told the user essentially the same thing;
  the gap between formatted and minified content was invisible.
  Chars is redefined to count source characters with whitespace
  and comments stripped, computed lexically via the
  `jsonc-parser` scanner (not via `JSON.stringify`, which would
  normalize lexemes - `1e3` -> `1000`, `1.0` -> `1`, `"\u0041"` ->
  `"A"` - and break the Min == Size invariant on already-minified
  input). Label stays `Chars`; the meaning is documented via an
  updated `aria-label` plus a new `title=` tooltip, and a
  matching tooltip is added to Size. Known limitation documented
  in DESIGN_SPEC.md: trailing commas in JSONC are still counted
  (the scanner emits `CommaToken` whether or not the AST keeps
  the comma).
- **0.15.2**: M7g-3g `.user-name` focus-visible 3:1 indicator
  (audit finding F5.1). The link in
  `src/app/shared/components/app-header/app-header.component.scss`
  now matches the `.brand` selector's existing
  `box-shadow: 0 0 0 2px rgba(0, 188, 212, 0.6)` focus-visible
  treatment, satisfying WCAG 2.4.7 / 1.4.11. New focus-visible
  regression spec in `app-header.component.a11y.spec.ts` uses
  stylesheet-rule introspection (programmatic `.focus()` does
  not reliably trigger `:focus-visible` in headless Chrome - the
  same reason the sibling `.skip-link` opts into bare `:focus`).
  Last open M7g audit finding before milestone close-out.
- **0.16.0**: M7g milestone close-out. All seven fix waves (3a -
  3g) have shipped; finding-level audit issues F1.1 through F6.1
  are addressed. The milestone marker in the Milestones list is
  flipped to done. Manual TBD checks from the M7g audit checklist
  (200% zoom verification at 1280x800, Windows Narrator route
  walkthrough, tab-order pass on each route, manual focus-
  restoration verification for `CloseMatMenuOnWindowBlurDirective`)
  are explicitly deferred and tracked separately. Deferred-finding
  GH issues (WCAG 2.5.8 target-size 24px, iOS VoiceOver pass,
  cross-browser pass, axe best-practice rules) are post-V1.
- **0.17.0**: Tree row density + scalable icon sizing. The tree
  body's `line-height` tightens from `1.55` to `1.4`, and tree
  icon chrome (kebab pill, extract pill, decoded pill, twisty,
  beacon badge, formatting-rule key/value icons) now scales with
  the user's `treeFontSize` preference instead of pinning at
  fixed pixel sizes. Three coordinated changes: (1) the
  `<jj-icon>` shared component gains a new `size: 'auto'` mode
  (alongside the existing `size: number`) that omits the SVG's
  intrinsic `width`/`height` HTML attributes and lets the host
  element default to `1em x 1em` via a `:host(.jj-icon--auto)`
  rule, so consumers can size icons with CSS instead of fighting
  the component's emitted attrs; (2) the tree's button wrappers
  use `em`-relative sizes (`.tree-kebab-pill` / `.tree-decoded-
  pill` / `.tree-extract-pill` at `1.25em`, `.tree-beacon-badge`
  at `1.25em`, `.tree-twisty` at `1.1em`) plus `font: inherit`
  to cancel the browser-default `<button>` font-size of
  `~13.33px` (`-webkit-small-control`) that would otherwise make
  `1.25em` compute against the wrong base; (3) the 12 tree-
  internal icons (`more-vert`, `extract`, `decoded`, `chevron-
  right`, `chevron-down`, plus the 7 `FormattingIcon` values
  `warning`/`check`/`star`/`info`/`error`/`flag`/`bookmark`) are
  redesigned with a uniform `1.288x` scale around their center
  using an SVG `<g transform>` group with `vector-effect:
  non-scaling-stroke`, so the visible glyph fills more of the
  24x24 viewBox while strokes stay at the original 1.75 user-
  unit thickness. Net effect: at the default 13px tree font,
  rows go from `~22px` to `~18-19px` (~14% denser); at the
  minimum 8px tree font, rows go from `~28px` to `~12-13px`
  (>2x denser, finally making the small-font option useful).
  Row alignment also flips from `align-items: baseline` to
  `center` on `.tree-row` and `.tree-row-right` because
  baseline alignment with replaced inline-flex content (the
  icon SVGs) synthesizes baselines at the bottom of the button
  box and inflated rows even with em-sized buttons. Hit-target
  trade-off: at 8px tree font, the kebab pill is ~10px square -
  sub-WCAG-2.1 24x24 minimum. Acceptable because (a) JotJSON is
  desktop-first, (b) the user explicitly opts into the small
  font, and (c) the row menu remains reachable via right-click
  anywhere on the row and via keyboard. The 7 `FormattingIcon`
  values are also rendered in the toolbar beacon-pills surface,
  which gets the redesigned icons "for free" - a consistency
  win, not a regression. Out of scope: redesigning the
  remaining ~28 icons used by other surfaces (toolbar, sidebar,
  etc.); those keep their original viewBox padding pending a
  future cleanup pass.
- **0.16.5**: M7f milestone close-out (M7f-4b no-op + spec
  flip). The M7f-4b "native-control sweep after `color-scheme`"
  wave ships nothing concrete: with the M7f-1 `color-scheme: dark | light`
  declarations on `.theme-dark` / `.theme-light` / `.theme-system`
  (under the `prefers-color-scheme: light` media query), native
  UA-painted controls - scrollbars, autofill chrome, native form
  fields, `<input type="color">` swatches - follow the active
  theme automatically. Audit confirmed zero pre-existing
  `scrollbar-color` or `:-webkit-autofill` rules in tracked SCSS,
  so nothing conflicts with the new `color-scheme` declarations.
  Deferred from M7f as out of scope for v1: theme-aware OG image
  / favicon, empty-state illustrations, Monaco diff editor
  styling. The Polish & launch milestone marker for M7f flips to
  done; all five sub-waves (1, 2, 3, 4a, 4b) are landed.
- **0.16.4**: M7f-4a hardcoded semantic-pill colors moved to
  Material 21 tokens. The three previously hardcoded "light-only"
  semantic-color pills now reference Material 21 semantic tokens so
  they auto-flip between dark and light themes via the
  `mat.all-component-colors` emission in `src/styles/_material.scss`:
  `.state-pill--modified` (toolbar) -> `--mat-sys-secondary-container`
  / `--mat-sys-on-secondary-container` (was `#ffecb3` / `#4a3000`);
  `.pill-warn` (rule-editor) -> `--mat-sys-secondary-container` /
  `--mat-sys-on-secondary-container` (was `#fef3c7` / `#78350f`);
  `.pill-ok` (rule-editor) -> `--mat-sys-tertiary-container` /
  `--mat-sys-on-tertiary-container` (was `#dcfce7` / `#14532d`).
  Material 21 has no dedicated "warning" semantic role distinct from
  secondary, so the warn pill uses secondary-container as the
  closest neutral-attention match; if the visual signal proves
  insufficient the per-theme override fallback noted in the rule
  block can be wired in. New stylesheet-introspection specs in
  `toolbar.component.spec.ts` (one) and `rule-editor.component.spec.ts`
  (three) assert each rule references the expected token and guard
  against regressions to bare hardcoded hex.
- **0.16.3**: M7f-3 Monaco JSON syntax theming + dead `$json-*`
  token cleanup. The `defineThemes()` calls on `JsonEditorComponent`
  now register `rules` arrays mapping JSON tokenizer scopes
  (`string.value.json`, `number.json`, `keyword.json` - verified
  against `monaco-editor/esm/vs/language/json/tokenization.js` in
  Monaco 0.55.1) to per-theme palette colors that mirror the tree's
  `--tree-string-color` / `--tree-number-color` / `--tree-boolean-color`
  values, so the editor and the tree feel like one surface in both
  themes. Property keys (`string.key.json`) inherit from the base
  `vs` / `vs-dark` palette unchanged. Three new integration specs
  spy on `monaco.editor.defineTheme` and assert the registered rule
  shape for each theme. The unused `$json-string` / `$json-number` /
  `$json-boolean` / `$json-null` / `$json-array` / `$json-object`
  SCSS tokens (zero refs in tracked SCSS) are removed from
  `src/styles/_variables.scss`; `DESIGN_SPEC.md` UI/UX Color Palette
  bullet now points at the three canonical sources (tree CSS
  variables, Monaco theme rules, `TreeHighlightColors`) instead of
  the deleted variables file.
- **0.16.2**: M7f-2 theme toggle UX. Replaces the static
  `matTooltip="Toggle theme"` and `aria-label="Toggle theme"` on the
  toolbar theme-toggle button with a predictive 3-state computed
  label that names the next state in the `light -> dark -> system`
  cycle: `light` -> "Switch to dark theme", `dark` -> "Match system
  theme" (matches the Profile dropdown's "Match system" copy),
  `system` -> "Switch to light theme". The aria-label binds to the
  same computed value so screen readers get the same affordance.
  Three new i18n message IDs (`@@toolbar.theme.tooltip.toLight`,
  `@@toolbar.theme.tooltip.toDark`, `@@toolbar.theme.tooltip.toSystem`)
  replace the legacy `@@toolbar.theme.tooltip` and
  `@@toolbar.theme.aria` entries; rename is justified because one
  static concept becomes three semantically distinct messages. Three
  new toolbar-component specs assert the tooltip + aria-label across
  all three current-state values; the existing
  `triggerThemeToggleButtonClick` helper is updated to find the
  button by any of the three valid dynamic aria-labels.
- **0.16.1**: M7f-1 theme propagation infrastructure. Three
  related changes ship together so the **active** theme - including
  explicit overrides that disagree with `prefers-color-scheme` - is
  honored by browser chrome, native UA-painted controls, and the
  cold-boot splash. (1) `<meta name="theme-color">` is now a pair
  of `media`-scoped tags (one for each scheme) plus a
  `PreferencesService` effect that strips `media` and forces both
  `content` values to the resolved color when the user picks an
  explicit override. The effect is gated on a new
  `isPlatformBrowser(inject(PLATFORM_ID))` field so prerender ships
  the unmodified media-scoped pair. (2) `src/styles/_theme.scss`
  declares `color-scheme: dark | light` on the corresponding theme
  classes (and inside the `prefers-color-scheme: light` media query
  for `.theme-system`) so native scrollbars, autofill, and color
  inputs follow the active palette. (3) An inline classic
  `<script>` immediately after `<body>` reads
  `localStorage['jotjson.preferences.v1']` and applies an explicit
  `theme-dark` / `theme-light` body class before the static splash
  is parsed, eliminating the wrong-palette flash on cold boot when
  the stored preference disagrees with the OS. The splash CSS gains
  matching `.theme-dark .jot-splash` / `.theme-light .jot-splash`
  variants so the class-based override beats the existing
  `prefers-color-scheme` media query. Supporting infrastructure:
  the inline-script bytes are mirrored by a pure helper at
  `src/app/core/boot/resolve-boot-theme.ts` (unit tested), the
  first inline-script SHA-256 hash is added to
  `staticwebapp.config.json` `script-src`, and both source-mode and
  dist-mode CSP-hash checks pass. New specs cover the meta-tag
  effect across the four `system`+OS / `dark` / `light` permutations,
  the `color-scheme` rules via stylesheet introspection, and the
  boot-theme helper.
- **Pre-V1**: stays at the current pre-v1 version for non-feature work;
  minor bumps applied for new user-visible features per the rules above. The
  build counter + SHA in the status-bar badge remain the per-build
  identifier through pre-V1.
- **V1 launch**: one-time bump to `1.0.0` via `npm version major`
  when the remaining M7 polish items ship.
- **Post-V1**: SemVer rules above apply unchanged.
- **Release ritual**: developer runs `npm version <type>` on `main`.
  This commits the bump and creates an annotated tag in one step. CD
  deploys on push-to-main, not on tag, so the tag does not
  double-deploy.

---

## Milestones

1. ~~**Project scaffolding** - Angular app, Azure Functions project, Cosmos DB setup, CI/CD pipeline.~~ (done)
2. ~~**Core editor experience** - JSON input + tree view on `/`, localStorage persistence, no auth.~~ (done)
3. ~~**Auth integration**~~ (done) - Microsoft Entra External ID + MSAL Angular, delivered in three steps:
   - ~~**M3a**: Plumbing - MSAL bootstrap, `AuthService`, sign-in/sign-out toolbar control, signed-in user signal, HTTP interceptor attaching access tokens to `/api/*` calls, auth guard available (not yet applied to any route). Tenant/app-registration config read from environment/app-settings. No user-facing protected pages yet.~~ (done)
   - ~~**M3b**: Profile page scaffold at `/profile` (display name, read-only email, sign-out button). Route is auth-guarded.~~ (done)
   - ~~**M3c**: Migrate preferences from `localStorage` to the signed-in user. On sign-in, the client calls `GET /api/me`; if the user document exists, its preferences replace the local copy (remote wins). If it does not exist (first sign-in ever), the client `POST`s the current local preferences to `/api/me` to seed the server - the anon user's customizations are preserved exactly once. Subsequent changes are mirrored to Cosmos via a debounced `PUT /api/me/preferences` while the user is signed in; anonymous usage continues to read/write `localStorage`. The server rejects unknown keys and out-of-range values on every write.~~ (done)
4. ~~**Persistent links** - Blob CRUD API, save & share flow, `/s/:id` route.~~ (done)
   Broken into three sub-milestones:
   - ~~**M4a**: API + core share flow. Cosmos `blobs` container
     (partition key `/ownerId`), server-side `POST /api/blobs`,
     `GET /api/blobs/:idOrSlug`, and `PUT /api/blobs/:id` with
     NanoID(6) slug generation + collision retry, zod validation,
     1 MB server-side size enforcement, and `isPublic` defaulting to
     `false`. Client-side: an inline editable title field plus a
     Save button in the toolbar (disabled for anonymous users with a
     "Sign in to save & share" tooltip); `HomeComponent` owns a
     nullable `loadedBlob` signal and chooses update-in-place vs.
     create-new-slug based on ownership (Gist/Pastebin semantics -
     owner updates in place, non-owner forks on save). The `/s/:slug`
     route is routed through `HomeComponent` via a resolver that
     pre-loads the blob; the placeholder `ShareComponent` retires.
     Per-blob browser tab title via the Angular `Title` service
     (`"<title or 'Untitled'> | JotJSON"`) that resets to the homepage
     title when the loaded blob clears. Anonymous users can view any
     `/s/:slug` link but cannot save. `DELETE` and list endpoints are
     deferred to M4b.~~ (done)
   - ~~**M4b**: Owner management. `DELETE /api/blobs/:id`,
     `GET /api/blobs` (paginated list of the caller's blobs),
     `isPublic` toggle in the toolbar overflow menu, `/history` page
     enumerating the owner's blobs with open/edit/delete/share
     actions, and the 100-blob cap UX (auto-FIFO default with a
     one-time explainer modal, or abort-with-prompt for users who pick
     the `manual` strategy).~~ (done)
   - ~~**M4c**: SEO + 404 polish. Open Graph meta tags on public blobs
     (`/s/:slug` where `isPublic === true`), `noindex` meta on private
     blobs, friendly "Blob not found" 404 page for invalid slugs,
     `/history` loading skeleton and empty state.~~ (done)
5. ~~**History** - Activity tracking for signed-in users.~~ (done) Broken into:
   - ~~**M5a**: Server-side event tracking plumbing (no UI change).
     New Cosmos `history` container (partition key `/userId`).
     `HistoryEntry` documents written on blob mutations - `"saved"`
     on create, `"edited"` on update, `"deleted"` on delete,
     `"viewed"` when a non-owner authenticated user fetches a blob,
     and `"pasted"` when the client records it via
     `POST /api/history`. All non-save recordings are gated by the
     `historyTrackingMode` preference (`"save_only"` vs.
     `"all_actions"`). Each entry snapshots `slug` and `title` so
     the timeline can still render a meaningful row after the
     underlying blob is deleted. Retention: **1,000 entries per
     user, FIFO** when the cap is exceeded. Paste events are
     debounced to one entry per 60 seconds per user. Endpoints:
     `GET /api/history` (paginated, newest first),
     `DELETE /api/history` (clear all for the caller),
     `POST /api/history` (client-recorded `"pasted"` events only in
     v1).~~ (done)
   - ~~**M5b**: UI surface. (The M4b blob list was moved from
     `/history` to `/blobs` ahead of M5b - feature folder, route,
     i18n message IDs, and app-header link label all updated.) A new
     `HistoryComponent` at `/history` renders the event timeline
     (grouped by day with Today/Yesterday/locale-date headers, action
     icon + blob title/slug/"(deleted blob)" fallback, click-to-open
     for live blobs, loading skeleton + empty state, "Load more"
     pagination, and a "Clear history" action hitting
     `DELETE /api/history`). HomeComponent fires
     `POST /api/history` on paste for signed-in users only - both the
     toolbar Paste button and direct in-editor paste (Ctrl/Cmd+V) trigger
     the call. No server
     redirect from the old `/history` URL; the timeline is a
     reasonable landing page for anyone who bookmarked it.~~ (done)
   - ~~**M5c**: Timeline polish. Keyword search over blob title + slug
     snapshots (`?q=`), action chip filter (`?actions=`), date-range
     filter (`?from=`/`?to=`), and IntersectionObserver-driven infinite
     scroll with the "Load more" button retained as an a11y/keyboard
     fallback. All filters are server-side; the continuation token
     round-trips Cosmos's opaque page cursor.~~ (done)
   - ~~**M5d**: Profile preferences UI. Add a Preferences card on
     `/profile` covering every persisted `UserPreferences` field whose
     backing feature is wired today: editor (font size, tab size, word
     wrap), tree (default expansion depth, type labels), search (scope,
     case sensitive, regex), history & storage (history tracking mode,
     blob quota strategy), and appearance (theme, layout orientation -
     mirroring the existing header/toolbar controls). Changes
     auto-apply via `PreferencesService.update()` (no Save button).
     `treeShowDateAnnotations`, `defaultRuleSetId`, and
     `treeHighlightColors` stay deferred to M7c, M6, and M7d
     respectively.~~ (done)
   - ~~**v1 narrowing (post-M5d audit)**: an audit of the shipped
     timeline found that `saved` / `edited` rows duplicated `/blobs`
     and that `deleted` / `pasted` rows were dead-end tombstones. v1
     narrows the feature to `viewed` rows only, with a 5 minute
     server-side debounce per `(user, blob)`. The page is rebranded
     "Recently viewed" (URL preserved at `/history`). The
     `historyTrackingMode` preference is replaced by
     `recentlyViewedEnabled` (boolean, default on; both legacy
     `'save_only'` and `'all_actions'` coerce to `true` since the
     narrowed feature is strictly less invasive than either old
     mode). Existing Cosmos rows of other action types are filtered out on
     read (`c.action = "viewed"` in `listEntries`); they age out via
     FIFO. The editor's `pasteOccurred` output and the
     `HistoryService.recordPaste` method are removed; the
     native-paste auto-unescape behavior is preserved.~~ (done)
   - ~~**Read-side legacy folds**: `normalizeStoredPreferences`
     (`api/src/shared/preferences.ts`), `readRecentlyViewedEnabled`
     (`api/src/functions/blobs.ts`), and `cleanupUserReferences`
     (`api/src/functions/ruleSets.ts`) used to tolerate the
     pre-narrowing `historyTrackingMode`, `defaultRuleSetIds`, and
     `defaultRuleSetId` shapes on stored user/blob documents and fold
     them into the current shape on read. The folds have been removed;
     the API now strips the legacy keys for wire hygiene and defaults
     stale-shape `activeRuleSetIds` to `[]`. The schema-evolution
     playbook used by future renames is in -> Versioning -> Schema
     evolution.~~ (done)
6. **Formatting rules** - Rule set CRUD API, rule builder UI, tree view integration, built-in presets. Broken into nine sub-milestones:
   - ~~**M6a**: Spec finalization (round 1). Close the first batch of
     cross-cutting design questions (storage shape, limits config,
     preset ID format, `borderColor` rendering, multi-set precedence)
     and document the answers in `DESIGN_SPEC.md`. No code changes.~~ (done)
   - ~~**M6a.5**: Spec finalization (round 2). Close the deeper design
     questions surfaced by the rubber-duck pass: rule labelling
     (auto-generated, no `name` field), rule-set ordering (by
     `createdAt`), engine output shape (`{ rowStyle, keyStyle,
     valueStyle, matchedRules }`), field-length caps, icon whitelist
     enum, regex-policy decision (defer `regex` match type to v1.1),
     `defaultRuleSetId` auto-clear on delete, match semantics for
     non-string values, active-set persistence
     (`activeRuleSetIds` on `UserPreferences`), concurrency model
     (`version` field + `If-Match` + 412), and update payload shape
     (full replace). Spec-only commit; no code.~~ (done)
   - ~~**M6a.75**: Prerequisite code refactors. Engine contract stub
     (`formatting-rules-engine.ts` returning the M6a.5 result shape
     with no callers), tree-row CSS-custom-property seam (no visual
     change - existing colors become CSS-var defaults), model field
     additions per M6a.5 (icon whitelist, `version` field,
     `activeRuleSetIds`), and applying `authGuard` to the
     `/formatting-rules` route (currently unguarded).~~ (done)
   - ~~**M6b**: API CRUD foundation. Validators (`assertRuleSet`,
     `assertRule`, `assertStyle`) following the `assertEnum` /
     `assertInt` / `assertHex` pattern, Cosmos repository
     (`ruleSetRepository.ts`), and the five owner-scoped functions
     (`createRuleSet`, `listRuleSets`, `getRuleSet`, `updateRuleSet`,
     `deleteRuleSet`) registered in a single
     `api/src/functions/ruleSets.ts` file (mirrors
     `api/src/functions/blobs.ts`, not one folder per function).
     Limit enforcement (20 sets/user, 50 rules/set, name <= 80,
     matchValue <= 200) via hardcoded constants in
     `api/src/shared/limits.ts`. **Owner mismatch returns 403** via
     the existing `forbidden()` helper (consistent with `blobs.ts`
     PUT/DELETE); missing IDs return 404. PUT enforces `If-Match`
     against the stored `version`; mismatch returns 412. DELETE
     auto-clears `defaultRuleSetId` and prunes `activeRuleSetIds`.
     Jest specs for validators, repo, and each handler.~~ (done)
   - ~~**M6c**: Built-in presets. Define the three preset rule sets in
     `api/src/shared/ruleSetPresets.ts` with stable kebab-case IDs
     (`error-detection`, `status-codes`, `null-finder`). The
     `status-codes` preset ships as individual `exact`-match rules
     per common code (200/201/204 green; 400/401/403/404 amber;
     500/502/503 red) since the `regex` match type is deferred to
     v1.1. Add `GET /api/rule-set-presets` and
     `POST /api/rule-set-presets/:id/clone` endpoints; the clone
     endpoint creates a user-owned UUID copy and reuses the
     limit-enforcement path.~~ (done)
   - ~~**M6d**: Rule builder UI with valid-only autosave. Ships as
     three sub-commits matching the M6f cadence:~~ (done)
     - ~~**M6d-1**: Editor scaffold + minimal list page + manual Save.
       New route `/formatting-rules/:id` loads a `RuleEditorComponent`
       with target (key / value / both), match type (exact /
       contains / starts_with / ends_with - no regex in v1), match
       value, case-sensitivity, and full style picker (background,
       text, bold/italic/underline, border, optional icon from the
       whitelist). Auto-generated rule labels per F1
       (`value contains "error"`); no editable rule.name field in
       v1. The stub `/formatting-rules` page is replaced with a
       minimal list (cards from `RuleSetsService.ruleSets()` cache +
       Edit button + "+ New rule set" creator). M6e expands the
       list to full CRUD (rename, duplicate, delete, ordering,
       clone-preset CTA). Save is a manual button; 412 surfaces a
       snackbar.~~ (done)
     - ~~**M6d-2**: Local-draft + valid-only autosave + 412 banner.
       Debounced 500 ms autosave gates on a `validity` computed
       signal; status pill cycles through `Editing`, `Saving...`,
       `Saved`, `Save failed - retry`, `Invalid - fix to save`.
       412 surfaces a "changed in another tab" banner with a
       Reload button that re-fetches and rehydrates the draft.~~ (done)
     - ~~**M6d-3**: Live preview. New optional `[overrideRuleSets]`
       Input on `JsonTreeComponent` lets a `RulePreviewComponent`
       render a built-in sample snippet through the production
       tree with only the in-progress rule set applied (home
       tree behavior unchanged when the input is unset). The
       component also accepts an optional `embeddedMode` Input;
       when true (used by the rule-editor live preview) it
       disables the persisted search box, both so the preview
       cannot read or write the home tree's search state and so
       the search UI is not exposed in contexts where it isn't
       useful.~~ (done)
   - ~~**M6e**: List page wraps the editor. Registered-user-only
     `/formatting-rules` page: list cards (one per set, sorted by
     `createdAt`), empty state with "Create your first rule set"
     CTA, create / rename / duplicate / delete actions, and a
     "Clone preset" affordance that calls
     `POST /api/rule-set-presets/:id/clone` and navigates into the
     M6d editor for the new set. Anonymous users hit the
     `authGuard` (applied to the route in M6a.75). New
     `RuleSetsService` (signals + optimistic update, mirrors
     `BlobsService` shape) lands here as the list page's first
     consumer, and also owns `activeRuleSetIds` round-trips.~~ (done)
   - ~~**M6f**: Tree-view integration. Implement the engine in
     `formatting-rules-engine.ts` (contract sketched in M6a.75)
     taking active `FormattingRuleSet[]` plus a tree node and
     returning the M6a.5 `RuleEngineResult`. Implements within-set
     rule-list order, cross-set `createdAt` order (later overrides
     earlier), and the highlight-priority suppression rule
     (selection -> match-value -> ancestor -> search -> manual ->
     formatting rules). Memoization keyed on
     `(activeSetIds, ruleSetVersionBitmap, key, value, type)` so a
     5 MB tree (perf NFR §Non-Functional Requirements) does not
     re-evaluate on unrelated state changes. Tree row applies the
     result via the CSS-var seam introduced in M6a.75, not via
     ngStyle vs class specificity. Default-set toolbar above the
     tree (chip list to toggle which sets apply) bound to
     `defaultRuleSetIds`. Profile page gets a "Default rule
     sets" multi-select wired to the same `defaultRuleSetIds`
     field as the home-page toolbar (closes the M5d-deferred
     item on line 459).~~ (done)
   - ~~**M6f-5**: Drop the vestigial `defaultRuleSetId` (never
     wired to seed any UI) and rename `activeRuleSetIds` to
     `defaultRuleSetIds` to better capture the field's
     persisted-preference intent. Surface it as the Profile
     "Default rule sets" multi-select. Migration: legacy
     `activeRuleSetIds` and `defaultRuleSetId` fields on stored
     user documents are folded into `defaultRuleSetIds` on read
     and dropped on next save.~~ (done)
   - ~~**M6g**: Polish. Telemetry events
     (rule-set created/updated/deleted/applied via `LoggerService`,
     no user content), a11y pass (keyboard nav, screen-reader labels
     on every color picker, focus management on add/delete),
     WCAG-AA color-contrast warning in the editor preview when the
     chosen `textColor` x `backgroundColor` pair fails in either
     theme (non-blocking), a minimal offline pattern for the
     rule-set service (cached reads + queued writes - documented in
     `AGENTS.md` as the pattern for later features), and final
     `DESIGN_SPEC.md` + `AGENTS.md` updates capturing any
     conventions that emerged.~~ (done)
     - Offline-write coverage in v1 is **`update` and `delete` only**.
       `create` and `clonePreset` remain online-required because
       offline create would need temp-ID -> server-ID reconciliation
       and is out of scope for "minimal". The rule editor surfaces a
       `Saved offline` pill when a queued write is pending; the
       service replays the queue on the next `online` event or
       sign-in. See `AGENTS.md` -> "Offline-first patterns" for the
       canonical pattern.
7. **Polish & launch** - Each of these lands as its own step/commit:
   - ~~**M7a**: Smart clipboard polling + banner prompt for the Paste button (Home page §1).~~ (done)
   - ~~**M7b**: Drag-and-drop file upload with full-page drop overlay (Home page §1).~~ (done)
   - ~~**M7c**: Smart date/time detection + relative-time annotations in the tree view (Home page §1).~~ (done)
   - ~~**M7d**: Selection highlighting (selected row + matching-value rows + ancestor chain) in the tree view (Home page §1).~~ (done)
   - ~~**M7e**: Custom domain (`jotjson.com`).~~ (done)
   - ~~**M7f**: Dark/light theme polish.~~ (done)
     - Five sub-waves shipping incrementally as patch
       releases. M7f-1: theme propagation infrastructure
       (dual `<meta name="theme-color">` tags + browser-only
       effect that strips `media` on explicit overrides;
       `color-scheme: dark | light` declarations in
       `_theme.scss`; first inline-script CSP hash for the
       cold-boot splash flicker fix). M7f-2: predictive
       3-state tooltip + aria-label on the toolbar theme
       toggle, replacing the static "Toggle theme" copy.
       M7f-3: Monaco JSON syntax token theming via per-theme
       `rules` arrays mapping `string.value.json`,
       `number.json`, `keyword.json` to the tree palette;
       removal of unused `$json-*` SCSS tokens. M7f-4a:
       three hardcoded "light-only" semantic-color pills
       (`.state-pill--modified`, `.pill-warn`, `.pill-ok`)
       moved to Material 21 `--mat-sys-secondary-container`
       / `--mat-sys-tertiary-container` tokens. M7f-4b:
       no-op close-out. With the M7f-1 `color-scheme`
       declaration in place, native UA-painted controls
       (scrollbars, autofill, color-input swatches) follow
       the active theme automatically with no further
       overrides; an audit confirmed zero pre-existing
       `scrollbar-color` / `:-webkit-autofill` rules in the
       tracked SCSS, so nothing was at risk of conflicting
       with the new declaration. The deferred M7f-4b
       follow-ups (theme-aware OG image / favicon, empty-
       state illustrations, Monaco diff editor styling) are
       out of scope for v1.
   - ~~**M7g**: Accessibility audit.~~ (done)
     - Seven fix waves (3a-3g) closing audit findings F1.1
       through F6.1. Highlights: app-shell focus order +
       skip-link + landmarks (3a); WAI-ARIA Tree pattern with
       roving tabindex on the json-tree (3b); explicit Monaco
       editor a11y options + i18n label (3c); light-theme
       contrast remediation including theme-aware tree palette
       and breadcrumb chips (3d); focus polish + offline-pill
       aria-live + delete-confirm focus fallback (3e);
       reduced-motion sweep + new lint gate (3f); user-name
       focus-visible 3:1 indicator (3g). Manual TBD checks
       (200% zoom, Narrator, tab-order, focus-restoration)
       deferred; deferred-finding GH issues (target-size 24px,
       iOS VoiceOver, cross-browser, axe best-practice) are
       post-V1.
   - ~~**M7h**: SEO (pre-rendering + OG tags).~~ (done)
     - `@angular/ssr` static prerender of `/` and `/404`; `shell.html`
       fallback for everything else via `scripts/postbuild-seo.mjs`.
       Splash discrimination via `<meta name="prerendered">` marker
       (`LoadingSplashService` pre-latches `firstNavComplete` when
       present). Static OG/Twitter defaults + canonical in
       `src/index.html`; `public/{og.png,robots.txt,sitemap.xml}` shipped.
       Server-platform safety: `app.config.server.ts` MSAL stubs, no
       service worker on server, browser-only `inject()` guards in
       `LoadingSplashService` / `RuleSetsService` / `AppComponent` /
       `HomeComponent`. Build integration check at
       `scripts/check-prerender.mjs`. Out of scope (deferred):
       per-`/s/:slug` server-visible OG (`followup-share-og`) and
       real HTTP 404 status (`followup-true-404`). See SEO / Social
       section above for the full implementation.
   - ~~**M7i**: Monitoring (App Insights dashboards & alerts).~~ (done)
     - App Insights workbook (5 sections) + 4 alerts + 1 action group shipped. Bicep modules: `infra/modules/{actionGroup,alerts,monitoringWorkbook}.bicep` + `infra/main.bicep` wiring + `infra/modules/appInsights.bicep` outputs. Docs: see `docs/telemetry.md` -> "Dashboards & alerts (M7i)". Post-V1 follow-ups: issues #87-#94.
   - ~~**M7j**: Static Web Apps upgrade to Standard tier - flipped during M7e (commit 1ba34e1) because apex custom-domain binding requires Standard. See M7o for the BYO Functions follow-up.~~ (done)
   - ~~**M7k**: Surface JSONC comments in the tree view - the parser harvests every `//` and `/* */` comment in a second pass and attaches it to the nearest tree node; comments render as dimmed inline annotations on the same row as the value they document (trailing slot when on the same source line as the value, leading slot when introducing the next value). Single-line + ellipsis with full text via tooltip; toggleable via `treeShowComments` (default true). Comments do not participate in formatting-rules matching or tree search. Decoration-vs-data font philosophy codified alongside (commits `7d937c5` M7k-0 mockup-rule docs, `82f9073` M7k-1 parser harvest, `4f7d604` M7k-2 tree rendering, `66f695d` font philosophy, `fa02122` placement fix-up, plus this commit for M7k-3 preference + spec).~~ (done)
   - ~~**M7l**: Responsive layout - on viewports narrower than 768px, collapse the editor/tree split to a single visible pane: when persisted `paneVisibility` is `both`, render the tree pane by default (view-first at narrow widths); when persisted is `editor-only` or `tree-only`, honor the single-pane choice. The toolbar's segmented control collapses to a 2-state toggle (`editor-only` | `tree-only`); the persisted `paneVisibility` is never mutated by the override. Also collapse the status bar (M7m) to a single-line summary - keep Bytes, Lines, and Mode; hide Chars, cursor, nodes, depth, object/array counts, and the build/version badge.~~ (done)
   - ~~**M7m**: Status bar - a slim, always-visible strip along the bottom of the Home page that surfaces at-a-glance stats about the current document. Left cluster covers the raw text (character count, line count, byte size in UTF-8, current cursor line/column); right cluster covers the parsed tree (total node count, max depth, array vs. object counts, JSON vs. JSONC mode indicator). Stats update reactively as the user types. Hidden or collapsed to a single-line summary on narrow viewports (see M7l). No interactivity required in v1 - purely informational.~~ (done)
   - ~~**M7n**: Version & commit surfacing - replace the short-term `dev`/local-git SHA indicator with a CI-authoritative version badge. Build tooling injects `{ version, sha, builtAt, branch }` from `package.json` + `GITHUB_SHA` / `GITHUB_REF_NAME` env vars into a generated module (no local `git` dependency). Status bar (right cluster, after the mode badge) shows `vX.Y.Z - abc1234`, clickable to copy the full SHA to the clipboard and linking to the corresponding commit on GitHub. Also emit a one-line `console.info` banner on app start so the version lands in bug-report consoles. Release discipline: bump `package.json` `version` on user-visible releases (via `npm version`). Future follow-up (not part of this step): a `GET /api/version` endpoint so the frontend can also surface the backend SHA and flag skew.~~ (done)
     - Build-time version module (`src/app/core/version/version.ts`) generated from `package.json` + `GITHUB_SHA` / `GITHUB_REF_NAME`. Status bar surfaces `vX.Y.Z - abc1234` with click-to-copy SHA and a GitHub commit link; one-line `console.info` banner on boot. `GET /api/version` follow-up remains a future step. Commit `04d542f`.
   - **M7o**: Bring-your-own Functions migration. Move the API off SWA managed Functions onto a standalone Azure Function App (Consumption plan) linked to the SWA via Standard-tier linked backends. Enables Cosmos DB authentication via the Function App's system-assigned managed identity (eliminating the `COSMOS_KEY` primary-key fallback in `api/src/shared/cosmos.ts`), and removes the SWA managed-Functions `Authorization`-header rewrite quirk along with the `X-Jotjson-Authorization` workaround in `verifyAccessToken`. Out of scope for v1 unless we add a second Azure resource that needs MI auth (e.g., Blob Storage for avatars/exports in §Profile post-v1).
   - ~~**M7p**: Extract JSON from mixed-text paste - when a paste contains prose plus one or more JSON object/array literals (logs, `curl -v` transcripts, etc.), surface a non-destructive banner offering one-click extraction. Single block preserves comments via `jsonc-parser` `format()`; multiple blocks combine into a JSON array (comments lost). Primitives are not extracted. 1 MB input cap. Banner auto-clears when content changes (Home page §1).~~ (done)
   - ~~**M7q**: Tree row context menu + double-click copy - per-row right-click and kebab-button context menu in the tree view, with copy key / copy value / copy path / search by key / search by value / collapse / expand-all-from-here / expand-to-depth +1..+5. Items adapt to row kind, expansion state, and embedded mode. Double-click a row copies its value (raw text for primitives, pretty-printed JSON for containers). Keyboard-fired contextmenu is deferred to a future M7 (Home page §Tree View Panel).~~ (done)
   - ~~**M7r**: Title suggester (wand button) - heuristic suggestions for the document title. A small wand icon button between the title input and the state pill (signed-in users only) opens a menu of 2-7 candidate titles inferred from the current document. Computed lazily on click via a registry of pure strategy functions in `src/app/core/title-suggester/`, ordered by confidence and deduplicated case-insensitively, against the already-memoized parsed value plus the most recent uploaded/dropped file's name. Strategies cover known formats (`package.json`, Kubernetes, OpenAPI/Swagger, JSON Schema, GeoJSON, ARM, `tsconfig`, GitHub Actions workflows, Postman), HAL self-links, common identifier fields, type discriminators, top-level keys, descriptions, generic shape descriptions, and last-resort `firstChars` / `Untitled` fallbacks. A post-dedupe synthetic floor (`Untitled - YYYY-MM-DD` then `Untitled (n)`) guarantees at least 2 menu entries. The candidate's literal text is never logged in telemetry; only the strategy `source` and total candidate count.~~ (done)
    - ~~**M7s**: Tree string-leaf extract affordance - parsed string leaves are scanned 1000 ms after parse settle via the Web Worker extractor, with delimiter pre-screening, 50-item chunks, and a 10000-entry LRU cache. Extractable rows show a small row pill plus a context-menu item; clicks are source-version guarded, patch only the selected value range with `jsonc-parser` `findNodeAtLocation` + `applyEdits`, and preserve comments both outside the target subtree and inside the extracted JSONC payload. Telemetry records only counts and source enums.~~ (done)
    - ~~**M7t**: Prose-preserving in-tree extraction - correctness fix for M7s where strings containing prose around embedded JSON (for example, HTTP request text whose body is JSON but whose request line and headers are plain text) were replaced by only the parsed JSON. When prose is present, the tree extract action replaces the string with a structured object that preserves prose next to parsed JSON: 1 JSON block with no prose still becomes the bare value; N >= 2 blocks with no prose still become an array; 1 block with prose becomes `{ prefix?, json, suffix? }`; and N >= 2 blocks with prose becomes `{ prefix?, json1, between_1_and_2?, json2, ..., suffix? }` using 1-indexed `jsonN` keys and `between_<i>_and_<j>` inter-block prose keys. Prose segments whose `.trim()` is empty are omitted by design to keep output clean, so the wrapper is prose-preserving but not strictly byte-for-byte for whitespace-only segments. Single-block-with-prose preserves JSONC comments inside `json`; multi-block extraction, with or without prose, keeps M7s behavior and does not preserve comments. A BOM is preserved when it lands in prose because the prose-preserving path does not strip a leading BOM. The existing `tree.extract.click` telemetry event gains `proseSegments`, the count of prose segments that are non-empty after trim. The M7p paste-banner path keeps the old unwrap behavior for now; M7u will apply the same fix there.~~ (done)
    - ~~**M8**: Loading splash + route progress bar - eliminate the two blank-screen windows users hit when clicking a share link. (1) Cold-boot splash: a static splash (logo + thin top bar + label) is inlined into `<app-root>` in `index.html` so it renders before Angular bootstrap completes. The label is "Loading JotJSON..." by default, with a tiny inline `<head>` script swapping in "Loading JSON..." when the URL matches `/^\/s\/[^\/]+$/` so cold-boot deep-links paint with the right label on the first frame. Angular's `bootstrapApplication` removes the static markup automatically on first render. (2) Loading splash continuation: an Angular-side `LoadingSplashComponent` re-renders the same `.jot-splash` markup with a `$localize`'d label ("Loading JotJSON..." or "Loading JSON...") so the splash stays visible from page load through bootstrap and the share-blob resolver until the first route activation. Driven by a root-singleton `LoadingSplashService` that peeks `window.location.pathname` in its constructor and subscribes to `Router.events`; latches `kind=null` once the first nav settles, so in-app navigations never re-show the splash. (3) Route progress bar: an indeterminate top-of-viewport bar (8px, primary cyan with glow) shown for any pending navigation (resolver, lazy chunk, redirect). Owned by an eager root-singleton `NavigationProgressService` that subscribes to `Router.events` in its constructor and tracks in-flight navigations as a `Set<number>` keyed on event id - so a resolver-cancel-and-redirect sequence (e.g., `/s/:slug` 404 -> `/404`) keeps the bar visible without flicker. The visual `RouteProgressBarComponent` lives at `src/app/shared/components/route-progress-bar/`, sits as a sibling of `<router-outlet>` in `AppComponent`, is `aria-hidden` (decorative), suppresses itself while the loading splash is visible to avoid a double-rendered bar, and matches the splash bar's position and style for visual continuity at the bootstrap-to-app handoff. Reduced-motion fallback uses an opacity pulse (Remote Desktop sessions force `prefers-reduced-motion: reduce`, so a static fallback would look like a frozen page). The pre-bootstrap labels in `index.html` are documented i18n exceptions because they must render before the Angular i18n pipeline is initialized.~~ (done)

---

## Open Questions / Future Considerations

- **Collaboration:** Real-time collaborative editing (future - would need SignalR/WebSockets).
- **JSON Schema validation:** Let users supply a schema and validate blobs against it.
- **Diff view:** Compare two JSON blobs side-by-side.
- **Bulk export/import:** Export/import `.json` files in bulk (single-blob download is in v1).
- **API access:** Provide API keys for programmatic blob storage (developer tier).
- **Monetization:** Pro plan with higher limits (larger blobs, more storage, **owner-only blobs** where the slug alone isn't enough to view, custom slugs).
