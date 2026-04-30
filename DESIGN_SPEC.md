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
  isPublic: boolean
}
```

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
  defaultRuleSetIds: string[] (default: [] - rule sets applied by default when viewing JSON; mirrored in the home-page toolbar chips and the Profile multi-select; persisted server-side so the selection survives across sessions and devices; IDs that no longer resolve to an owned rule set are filtered out on read),
  editorWordWrap: boolean (default: true),
  layoutOrientation: "horizontal" | "vertical" (default: "horizontal" - editor left, tree right; "vertical" = editor top, tree bottom),
  treeFontSize: number (default: 13, range: 8-32),
  treeShowTypeLabels: boolean (default: true),
  treeShowDateAnnotations: boolean (default: true),
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
  searchHighlightColor: string     # search matches - rows matching the search query
}
```

**Default values by theme:**

| Color | Dark theme default | Light theme default |
|---|---|---|
| `selectionColor` | `#264f78` (muted blue) | `#cce4f7` (soft sky blue) |
| `matchingValueColor` | `#3e3d32` (warm gray) | `#fff4cc` (pale amber) |
| `ancestorColor` | `#2a2d2e` (subtle dark) | `#ececec` (subtle light gray) |
| `searchHighlightColor` | `#6a4c00` (muted amber/gold) | `#ffe082` (soft yellow) |

When the user has not overridden a color for a given theme, the app uses that theme's default. Switching themes swaps the active color set; overrides for the inactive theme are preserved. The "Reset to defaults" button in Profile -> Preferences restores the defaults for the **currently active theme only**.

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
```
{
  id: string,
  target: "key" | "value" | "key_and_value",
  matchType: "exact" | "contains" | "starts_with" | "ends_with",  # `regex` deferred to v1.1; see §Features 7
  matchValue: string,              # the literal to match (e.g., "error", "200"); max 200 chars
  caseSensitive: boolean,
  style: FormattingStyle
}
```

The rule's user-visible label (shown in hover tooltips and the editor's
matched-rule list) is auto-generated from its match config -
e.g. `key contains "error"`, `value exact "200"`. Rules have no
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

- **JSON Input Panel** (left or top, depending on layout preference)
  - Monaco Editor for syntax highlighting, line numbers, error markers, and JSON/JSONC-specific IntelliSense. Loaded lazily to offset its ~2 MB bundle size. Editor language mode auto-detects JSON vs JSONC based on content (presence of `//` or `/* */` comments) and can be toggled manually via a **JSON / JSONC** switch in the toolbar.
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
    - **Copy as escaped JSON string**: Alt-clicking the toolbar Copy button writes `JSON.stringify(editorContents)` to the clipboard - the inverse of auto-unescape - so the current document can be embedded as a string value in another JSON document. A plain click still copies the raw editor contents.
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
  - **Download as File** - a toolbar button saves the current editor content as a file to the user's device. Uses a client-side `Blob` + anchor `download` attribute - no server involvement. Default filename is the blob's title (slugified) or `jotjson-<slug>.json` for a saved blob, or `jotjson-untitled.json` for unsaved editor content. Extension is `.jsonc` when the editor is in JSONC mode (contains comments or user toggled JSONC), otherwise `.json`. Available to all users (anonymous + registered).

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
  - Type labels are styled with a muted/subdued color and a small monospace font so they don't compete with the key/value content. Type labels use a single muted color rather than per-type coloring - leaf values themselves already carry semantic color (strings, numbers, booleans, null), so coloring the type badge too would be visual noise.
  - Type labels can be toggled on/off via the "Show type labels" preference in user settings.
  - **Expansion controls** (toolbar above the tree):
    - **Collapse All** button - collapses every node in the tree.
    - **Expand All** button - expands every node in the tree.
    - **Expand to Level** - a dropdown (values 1-10) that expands nodes down to the chosen depth and collapses everything deeper. E.g., "Level 2" expands the root and its immediate children but collapses grandchildren.
    - The current expansion level is displayed and persists across re-renders of the same blob.
    - Keyboard shortcuts: `Ctrl+Shift+[` (collapse all), `Ctrl+Shift+]` (expand all), `Alt+1` through `Alt+9` (expand to level N - uses Alt to avoid conflicting with browser tab shortcuts).
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
  - **Selection highlighting** - clicking a row in the tree activates three highlight layers (colors below reference the active theme's values from `TreeHighlightColors`):
    - **Selected row** - highlighted in the user's **primary selection color**. Only one row is selected at a time.
    - **Matching value rows** - all other rows whose value is identical to the selected row's value are highlighted in the **secondary color**. Matching compares the raw JSON value (type-aware: `"1"` != `1`). A small badge icon appears on each matching row to make them easy to spot.
    - **Ancestor rows** - every parent node from the selected row up to the root is highlighted in the **ancestor color**, making it easy to see the path/context of the selection.
    - Theme-appropriate defaults are defined in the `TreeHighlightColors` section of the Domain Model.
    - Registered users can override each color individually (per theme) in the **Profile -> Preferences** section via color pickers.
    - Highlights clear when clicking outside the tree or pressing `Escape`.
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
  - **Double-click a row** copies the row's value to the clipboard with the same extraction semantics as the menu's **Copy value** action (raw text for primitives, pretty-printed JSON for containers). The dblclick path excludes the kebab pill and twisty toggle the same way single-click selection does, so clicking those buttons twice never triggers an unintended value copy. Emits the `tree.row.doubleClickCopyValue` telemetry event.
  - **Search highlight** - a persistent search field is positioned above the tree view panel (on its own row, full-width, above the expansion controls):
    - User types arbitrary text into the search field; matching is **live** as they type (debounced ~150ms).
    - Any row whose key or value contains the search text (case-insensitive by default) is highlighted in the **search highlight color** (theme-aware default defined in `TreeHighlightColors`).
    - The matched substring within the key or value text has an **inline background highlight** so users can see exactly what matched.
    - A match count is displayed next to the search field (e.g., "12 matches").
    - **Previous / Next** navigation buttons (and `Enter` / `Shift+Enter` shortcuts) jump between matches, auto-expanding collapsed parent nodes as needed and scrolling the match into view.
    - **Highlight priority**: if a row is both a search match and has a selection/matching-value/ancestor highlight, the selection highlights take precedence and the search highlight is suppressed for that row (avoiding visual noise).
    - Options available via small toggles next to the search field: **case sensitive**, **regex mode**, **keys only / values only / both**.
    - Clearing the search field (or pressing `Escape` while focused in it) removes all search highlights.
    - The search field is always visible - it does not need to be toggled open.
    - Keyboard shortcut: `Ctrl+F` is **context-aware** - when the editor panel is focused, it triggers Monaco's built-in find; when the tree panel is focused (or no panel is focused), it focuses the tree search field.

- **Layout:** Split-pane (resizable). **Horizontal** (default): editor left, tree right. **Vertical**: editor top, tree bottom. Toggled via a layout button in the toolbar or `layoutOrientation` user preference. On mobile (< 768px), always stacks vertically regardless of preference. A separate **pane-visibility** toolbar button cycles a 3-state visibility toggle - **Both -> Editor only -> Tree only -> Both** - removing the inactive pane and the splitter from layout via `display:none`. State is persisted per device under `jotjson.paneVisibility.v1` (local-only, like `splitRatio`); returning to "Both" automatically restores the previously saved `splitRatio`.

- **Status bar** (always-visible strip along the bottom of the page, shipped in M7m):
  - **Left cluster** (raw text stats): byte size in UTF-8, line count, current cursor position (`Ln X, Col Y`).
  - **Right cluster** (parsed tree stats): total node count, max depth, counts of arrays vs. objects, a JSON / JSONC mode badge, and a build indicator. The build indicator currently shows the local-git short SHA (with a `*` suffix when the working tree was dirty) sourced from a build-time generated module, as a short-term placeholder pending M7n; M7n replaces it with a CI-authoritative `vX.Y.Z - <shortsha>` badge that links to the commit on GitHub and copies the full SHA on click.
  - Stats update reactively as the user types. No interactivity beyond the version badge in v1.
  - On narrow viewports (< 768px) the bar collapses to a single-line summary per M7l, keeping Bytes, Lines, and the Mode badge and hiding cursor/nodes/depth/counts.

### 2. Persistent Link / Share  (`/s/:id`)

Available to **registered users** (create/manage). **Anonymous users can view any shared link** they have the slug for (both unlisted and public blobs).

- After submitting JSON, a registered user can click **"Save & Share"**.
- Generates a short, unique URL: `jotjson.com/s/abc123` (using the blob's NanoID slug).
- The link loads the saved JSON blob into the editor + tree view.
- **Visibility**: every saved blob is **private (unlisted) by default** - the link works for anyone who has it, but the blob is not listed on any public index, has a `noindex` meta tag, and does not emit rich Open Graph previews. The owner can toggle the blob to **public**, which enables Open Graph previews on `/s/:id` and allows indexing.
- Owner can update or delete the blob.

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
  - **Tree**: font size (8-32 px, clamped), default expansion depth
    (1-10, clamped), show type labels toggle.
  - **Search**: scope (keys / values / keys and values), case
    sensitive toggle, regex mode toggle.
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
  - **Default formatting rule sets** (M6) - multi-select listing the user's owned rule sets. Selected sets become the user's `defaultRuleSetIds` preference, mirrored as toolbar chips on the home page; the same selection appears in both places and persists across sessions and devices.

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
  - **Target:** pick whether the rule applies to keys, values, or both.
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
      `star`, `info`, `error`, `flag`, `bookmark`).
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
  - Rules match the **rendered text** the user sees in the tree, not
    the underlying JSON literal. So a `value contains "200"` rule
    matches the JSON number `200` (rendered as `200`), the JSON string
    `"200"` (rendered as `"200"` - the quotes are styling, not part of
    the matched text), `null`/`true`/`false` (rendered as their literal
    text). This keeps the user's mental model "what I see is what
    matches".
  - **Container nodes** (object `{}` and array `[]` rows) are excluded
    from value-target rules - they have no scalar value text to match.
    They remain eligible for key-target rules via their property name.
  - Rules whose match config is structurally invalid (empty
    `matchValue`, unknown enum, etc.) are skipped at evaluation time.

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

- **`defaultRuleSetIds` referential integrity:** when a rule set the
  user has marked as default is deleted, the `DELETE /api/rule-sets/:id`
  handler strips the deleted ID from `defaultRuleSetIds` on the user
  document in the same request. Clients refresh local prefs after a
  successful delete. The wire surface accepts only `defaultRuleSetIds`;
  stored user documents that still carry the legacy `defaultRuleSetId`
  / `activeRuleSetIds` fields (pre-M6f-5) are folded into
  `defaultRuleSetIds` on read by `normalizeStoredPreferences` and
  dropped on next save.

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
  - Rules with `target=key` produce `keyStyle` only;
    `target=value` -> `valueStyle`; `target=key_and_value` -> both.
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
  - **Within a rule set:** multiple rules can match the same node - styles are merged in rule-list order (later rules override earlier ones for conflicting properties).
  - **Across default rule sets:** sets are evaluated in `createdAt` order (oldest first) - the same order they appear in the user's saved list and the default-set toolbar. Later evaluations override earlier ones for conflicting style properties. Drag-to-reorder of default sets is a post-v1 follow-up.
  - The optional `borderColor` style renders as a 4px left-edge accent strip on the affected row (consistent with the `.pref-substack` pattern on the profile page) so it does not collide with the selection outline or ancestor highlights.
  - A tooltip on hover shows which rule(s) matched a given node (keeps the tree visually clean). Tooltip labels are auto-generated from each rule's match config.
  - **Highlight priority** (highest to lowest): selection highlight -> matching-value highlight -> ancestor highlight -> search highlight -> formatting rules. Higher-priority highlights suppress lower-priority ones on the same row.
  - A **formatting toolbar** above the tree view lets users quickly toggle rule sets on/off or pick which set to apply. Toolbar state is the user's `defaultRuleSetIds` preference and persists across sessions and devices; the same selection appears in the Profile "Default rule sets" multi-select.

- **Built-in Presets** - ship a few starter rule sets users can clone and customize. Preset IDs are stable kebab-case slugs (not UUIDs) so the clone endpoint URLs are human-readable and stable across rebuilds; user-created rule sets always get UUIDs.
  - `error-detection` ("Error Detection") - highlights keys and values that name an error / failure concept in red. Six rules, all `contains` and case-insensitive: `error`, `exception`, `fault`, `failure`, `failed` target both keys and values (so `{"data":"TypeError"}` highlights the value); `err` targets keys only because case-insensitive contains-match for "err" hits common English words in arbitrary value text (merry, berry, where, every).
  - `status-codes` ("Status Codes") - color-codes a fixed list of common HTTP response code values via `exact` matches: `200`, `201`, `204` (green); `400`, `401`, `403`, `404` (amber); `500`, `502`, `503` (red). Individual rules per code rather than a single regex - a documented v1 trade-off until the regex match type lands in v1.1.
  - `null-finder` ("Null Finder") - highlights all `null` values with a yellow background.
  - `status-highlights` ("Status Highlights") - color-codes outcome and lifecycle vocabulary on both keys and values, case-insensitive. Green: `success`, `succeeded`, `passed` (`contains`), `ok` (`exact` - avoids partial matches like "took" / "look" / "broken" while still catching `{"status":"OK"}`). Amber: `warning`, `pending`, `retry` (`contains`), `warn` (`exact` - avoids "Warner" / "warned" while catching `{"level":"warn"}`).

- **Limits (free tier):** max 20 rule sets per user, max 50 rules per rule set, rule-set name <= 80 chars, rule matchValue <= 200 chars. Enforced server-side as hardcoded constants in `api/src/shared/limits.ts` (mirrors the 100-blob cap pattern); raising them later is one edit.

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

### Shipped endpoints (v1)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | None | Liveness probe |
| POST | `/api/blobs` | Required | Create a new JSON blob |
| GET | `/api/blobs` | Required | List caller's blobs (newest first) |
| GET | `/api/blobs/:id` | Optional | Get a blob by UUID or slug. Public / unlisted blobs do not require auth; owner-only blobs (post-v1) will. |
| PUT | `/api/blobs/:id` | Required (owner) | Update a blob's content, title, or `isPublic` flag |
| DELETE | `/api/blobs/:id` | Required (owner) | Delete a blob |
| GET | `/api/me` | Required | Read the current user document. Returns 404 if not yet seeded. |
| POST | `/api/me` | Required | First-time seed: create the user document from the request body (typically the anon user's local preferences). Idempotent; 409 if already seeded. |
| PUT | `/api/me/preferences` | Required | Replace the preferences object with a validated + normalized copy. Returns the normalized preferences. |

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
| DELETE | `/api/rule-sets/:id` | Required (owner) | M6 | Delete a rule set. Removes the ID from the user's `defaultRuleSetIds` if matching. Owner mismatch returns 403 |
| GET | `/api/rule-set-presets` | Required | M6 | List built-in preset rule sets. Uses a top-level path (not `/api/rule-sets/presets`) because the Azure Functions Node.js v4 router resolves the latter to the parameterized `/rule-sets/{id}` handler |
| POST | `/api/rule-set-presets/:id/clone` | Required | M6 | Clone a preset into the user's rule sets |

### Validation Rules
- Max blob size: **1 MB** (free tier).
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
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: clipboard-read=(self), clipboard-write=(self)` - scopes the Clipboard API to the site's own origin so the Smart Paste polling (Home page §1) can read the clipboard without cross-origin leakage.
- **Planned:** a full Content Security Policy header that tightens allowed script / style / connect origins. Not yet shipped.

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
- Pre-rendering at build time for the `/` landing page (compatible with Static Web Apps; no server runtime needed).
- Open Graph tags for **public** shared blob links (`/s/:id`) - show preview of JSON structure. Private (unlisted) blobs emit a `noindex` meta tag and omit OG previews.

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
  - JSON types color-coded: strings=green (`#6a8759`), numbers=orange (`#ff9800`), booleans=blue (`#2196f3`), null=gray (`#9e9e9e`), arrays=purple (`#9c27b0`), objects=teal (`#009688`). Exact values live in `src/styles/_variables.scss`.
- **Logo:** "JotJSON" wordmark - "Jot" in regular weight, "JSON" in bold, with a `{ }` icon element.
- **Responsive breakpoints:** Mobile (< 768px), Tablet (768-1024px), Desktop (> 1024px).

### Error, Loading & Empty States

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
- **Production sourcemap upload to App Insights.** Currently no sourcemaps in production. Decide whether to wire symbol upload (would also require switching the SWA deploy to runner-side build via `skip_app_build: true`).
- **Testing-layer strategy.** The current test suite covers static analysis + unit (frontend) + unit (api) + browser integration. See the [Testing strategy](#testing-strategy) section below for the full layer model. Decide before v1 whether any of the tracked layers (api integration, smoke e2e, cross-browser, accessibility, visual regression) should be required v1 gates rather than post-v1 follow-ups.

---

## Testing strategy

JotJSON is layered: a static-analysis pass, two unit suites (frontend + Azure
Functions), and an in-browser integration layer for components whose real
runtime behavior cannot be faked cheaply (Monaco today; the same pattern
applies to anything else that depends on browser globals or external scripts).
Higher layers - api-integration against the Cosmos emulator, end-to-end smoke
flows in a real browser, cross-browser, accessibility, and visual regression -
are tracked as separate work items and are deliberately not gating v1.

| Layer | In place? | Purpose |
|---|---|---|
| Static analysis | yes | TypeScript `tsc --noEmit`, ASCII gate, spec-pattern lint. |
| Unit (frontend) | yes | Component / service / pipe / pure logic; Monaco and other browser globals are stubbed. Co-located `*.spec.ts`. |
| Unit (api) | yes | Azure Functions handlers and shared modules; Cosmos and Blob clients are mocked. |
| Browser integration | yes | Real Monaco loaded once per suite via the project's loader. Verifies the loader, the asset path, and the editor's mount + value roundtrip with a real DOM. Lives alongside frontend unit specs but is named `*.integration.spec.ts`. |
| API integration | tracked as issue | Functions + shared modules against the Microsoft Cosmos emulator container. Catches partition-key, query-shape, and continuation-token mistakes that mocks cannot. |
| Smoke e2e | tracked as issue | Playwright on critical user flows in Chromium. Catches MSAL redirect, router lazy-load, service-worker, and CSP regressions that unit + browser-integration cannot. |
| Cross-browser smoke | tracked as issue | Playwright matrix on Firefox + WebKit, run nightly. Catches engine-specific issues. (WebKit on Linux is not Safari; iOS-Safari still needs manual verification.) |
| Accessibility smoke | tracked as issue | `@axe-core/playwright` invoked from each smoke flow. Backs the WCAG 2.1 AA commitment in the Accessibility section. |
| Visual regression | tracked as issue | Pixel-diff of representative screens against a baseline. Post-v1 unless visual bugs become recurring. |

What this layer model deliberately does *not* claim:

- The **browser integration** layer does not prove worker correctness. The Monaco JSON worker spawns from a runtime-built blob URL; verifying that requires worker-specific assertions whose value at this layer is bounded. Worker-shaped bugs are expected to surface at the smoke-e2e layer once that exists.
- **Unit (api)** uses mocked Cosmos / Blob clients. Partition-key bugs, indexing-policy issues, and continuation-token correctness are all uncovered by today's CI; that is the gap the API integration layer closes.

Layer names above are runner-neutral so this model survives runner migrations
(see issue #47 - test-runner migration).

---

## Telemetry & Logging

JotJSON uses **Azure Application Insights** for both the SPA and the
Azure Functions backend. The resource is provisioned in
`infra/modules/appInsights.bicep` and shared between the two.

### Connection-string flow

- **Functions**: connection string injected as an app setting
  (`APPLICATIONINSIGHTS_CONNECTION_STRING`) by Bicep; the Functions
  runtime auto-instruments via `host.json`.
- **SPA**: connection string is baked into `environment.prod.ts` at CD
  time from the `APP_INSIGHTS_CONNECTION_STRING` GitHub secret. Empty
  value -> telemetry disabled in that build (no SDK chunk loaded). The
  CD step intentionally does NOT fail-closed when the secret is empty,
  so a deploy still succeeds without telemetry.

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
- **Dependencies (XHR/fetch)** - **on**, for SPA <-> Functions
  correlation. URLs are sanitized in a telemetry initializer (query
  string and fragment stripped). Ajax error response bodies are **off**
  (`enableAjaxErrorStatusText: false`).
- **Browser perf timings** - on (no PII).

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

- Functions: SDK default (adaptive sampling).
- SPA: 100% in v1.

### Sourcemaps

Production builds do **not** emit sourcemaps today (Angular default
for the `production` configuration). Production stack traces in App
Insights are therefore minified. Out-of-band symbol upload to App
Insights is a planned follow-up; when it lands, the SWA build
topology will switch to runner-side build (`skip_app_build: true`)
so the CI job controls the artifacts and can upload symbols before
deploy.

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
   - **Read-side legacy folds (deferred)**: `normalizeStoredPreferences`
     (`api/src/shared/preferences.ts`), `readRecentlyViewedEnabled`
     (`api/src/functions/blobs.ts`), and `cleanupUserReferences`
     (`api/src/functions/ruleSets.ts`) still tolerate the pre-narrowing
     `historyTrackingMode`, `activeRuleSetIds`, and `defaultRuleSetId`
     shapes on stored user/blob documents and fold them into the
     current shape on read (and drop them on next save). These can be
     removed in a follow-up commit once stored Cosmos data is verified
     clean.
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
     (selection -> match-value -> ancestor -> search -> formatting
     rules). Memoization keyed on
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
   - **M7f**: Dark/light theme polish.
   - **M7g**: Accessibility audit.
   - **M7h**: SEO (pre-rendering + OG tags).
   - **M7i**: Monitoring (App Insights dashboards & alerts).
   - ~~**M7j**: Static Web Apps upgrade to Standard tier - flipped during M7e (commit 1ba34e1) because apex custom-domain binding requires Standard. See M7o for the BYO Functions follow-up.~~ (done)
   - **M7k**: Surface JSONC comments in the tree view (e.g., attach leading/trailing comments from `jsonc-parser` to the nearest node and render them as dimmed annotations or a hover affordance).
   - **M7l**: Responsive layout - on viewports narrower than 768px, force the editor/tree split to stack vertically (editor on top, tree below) regardless of the user's `layoutOrientation` preference, per Home page §Layout. Also collapse the status bar (M7m) to a single-line summary - keep Bytes, Lines, and Mode; hide cursor, nodes, depth, and object/array counts.
   - ~~**M7m**: Status bar - a slim, always-visible strip along the bottom of the Home page that surfaces at-a-glance stats about the current document. Left cluster covers the raw text (character count, line count, byte size in UTF-8, current cursor line/column); right cluster covers the parsed tree (total node count, max depth, array vs. object counts, JSON vs. JSONC mode indicator). Stats update reactively as the user types. Hidden or collapsed to a single-line summary on narrow viewports (see M7l). No interactivity required in v1 - purely informational.~~ (done)
   - **M7n**: Version & commit surfacing - replace the short-term `dev`/local-git SHA indicator with a CI-authoritative version badge. Build tooling injects `{ version, sha, builtAt, branch }` from `package.json` + `GITHUB_SHA` / `GITHUB_REF_NAME` env vars into a generated module (no local `git` dependency). Status bar (right cluster, after the mode badge) shows `vX.Y.Z - abc1234`, clickable to copy the full SHA to the clipboard and linking to the corresponding commit on GitHub. Also emit a one-line `console.info` banner on app start so the version lands in bug-report consoles. Release discipline: bump `package.json` `version` on user-visible releases (via `npm version`). Future follow-up (not part of this step): a `GET /api/version` endpoint so the frontend can also surface the backend SHA and flag skew.
   - **M7o**: Bring-your-own Functions migration. Move the API off SWA managed Functions onto a standalone Azure Function App (Consumption plan) linked to the SWA via Standard-tier linked backends. Enables Cosmos DB authentication via the Function App's system-assigned managed identity (eliminating the `COSMOS_KEY` primary-key fallback in `api/src/shared/cosmos.ts`), and removes the SWA managed-Functions `Authorization`-header rewrite quirk along with the `X-Jotjson-Authorization` workaround in `verifyAccessToken`. Out of scope for v1 unless we add a second Azure resource that needs MI auth (e.g., Blob Storage for avatars/exports in §Profile post-v1).
   - ~~**M7p**: Extract JSON from mixed-text paste - when a paste contains prose plus one or more JSON object/array literals (logs, `curl -v` transcripts, etc.), surface a non-destructive banner offering one-click extraction. Single block preserves comments via `jsonc-parser` `format()`; multiple blocks combine into a JSON array (comments lost). Primitives are not extracted. 1 MB input cap. Banner auto-clears when content changes (Home page §1).~~ (done)
   - ~~**M7q**: Tree row context menu + double-click copy - per-row right-click and kebab-button context menu in the tree view, with copy key / copy value / copy path / search by key / search by value / collapse / expand-all-from-here / expand-to-depth +1..+5. Items adapt to row kind, expansion state, and embedded mode. Double-click a row copies its value (raw text for primitives, pretty-printed JSON for containers). Keyboard-fired contextmenu is deferred to a future M7 (Home page §Tree View Panel).~~ (done)

---

## Open Questions / Future Considerations

- **Collaboration:** Real-time collaborative editing (future - would need SignalR/WebSockets).
- **JSON Schema validation:** Let users supply a schema and validate blobs against it.
- **Diff view:** Compare two JSON blobs side-by-side.
- **Bulk export/import:** Export/import `.json` files in bulk (single-blob download is in v1).
- **API access:** Provide API keys for programmatic blob storage (developer tier).
- **Monetization:** Pro plan with higher limits (larger blobs, more storage, **owner-only blobs** where the slug alone isn't enough to view, custom slugs).
