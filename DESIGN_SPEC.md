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
| Routing | Angular Router (lazy-loaded feature modules) |
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
  theme: "dark" | "light" | "system",
  editorFontSize: number (default: 14, range: 10-24),
  editorTabSize: number (default: 2, range: 2 | 4),
  defaultTreeExpansionDepth: number (default: 3, range: 1-10),
  defaultRuleSetId?: string (auto-apply this rule set on load),
  editorWordWrap: boolean (default: false),
  layoutOrientation: "horizontal" | "vertical" (default: "horizontal" - editor left, tree right; "vertical" = editor top, tree bottom),
  treeShowTypeLabels: boolean (default: true),
  treeShowDateAnnotations: boolean (default: true),
  historyTrackingMode: "save_only" | "all_actions" (default: "save_only"),
  searchCaseSensitive: boolean (default: false),
  searchRegexMode: boolean (default: false),
  searchScope: "keys" | "values" | "both" (default: "both"),
  blobQuotaStrategy: "auto_fifo" | "manual" (default: "auto_fifo" - delete oldest blob when 100-blob cap reached; "manual" blocks the save with a prompt instead),
  seenBlobQuotaModal: boolean (default: false - flipped to true after the first-time quota explainer modal has been dismissed; synced server-side so the modal doesn't reappear on other devices),
  seenClipboardBanner: boolean (default: false - flipped to true after the first-time paste-permission banner has been dismissed; synced server-side so the banner doesn't reappear on other devices),
  treeHighlightColors: TreeHighlightColors
}
```

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
| `selectionColor` | `#264F78` (muted blue) | `#CCE4F7` (soft sky blue) |
| `matchingValueColor` | `#3E3D32` (warm gray) | `#FFF4CC` (pale amber) |
| `ancestorColor` | `#2A2D2E` (subtle dark) | `#ECECEC` (subtle light gray) |
| `searchHighlightColor` | `#6A4C00` (muted amber/gold) | `#FFE082` (soft yellow) |

When the user has not overridden a color for a given theme, the app uses that theme's default. Switching themes swaps the active color set; overrides for the inactive theme are preserved. The "Reset to defaults" button in Profile -> Preferences restores the defaults for the **currently active theme only**.

#### HistoryEntry
```
{
  id: string,
  userId: string,
  blobId: string,
  accessedAt: DateTime,
  action: "saved" | "viewed" | "edited" | "pasted"
}
```

#### FormattingRuleSet
```
{
  id: string,
  userId: string,
  name: string,                    # e.g., "Error Highlighter", "API Response Theme"
  rules: FormattingRule[],
  createdAt: DateTime,
  updatedAt: DateTime
}
```

#### FormattingRule
```
{
  id: string,
  target: "key" | "value" | "key_and_value",
  matchType: "exact" | "contains" | "regex" | "starts_with" | "ends_with",
  matchValue: string,              # the pattern to match (e.g., "error", "^err_.*")
  caseSensitive: boolean,
  style: FormattingStyle
}
```

#### FormattingStyle
```
{
  backgroundColor?: string,        # hex color, e.g., "#FFEB3B"
  textColor?: string,              # hex color
  bold?: boolean,
  italic?: boolean,
  underline?: boolean,
  borderColor?: string,            # outline/border highlight color
  icon?: string                    # optional icon identifier (e.g., "warning", "check", "star")
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
  - **File Upload** - two ways to load a JSON file:
    - **Toolbar button** ("Upload File"): opens a native file picker filtered to `.json`, `.jsonc`, `.jsonl`, `.geojson`, and `.txt` extensions. Reads the selected file client-side via the `FileReader` API and loads its contents into the editor.
    - **Drag & drop**: users can drag a file from their desktop onto **any part of the page**. A full-page drop zone overlay appears with a visual cue (dashed border + "Drop JSON file here" message) when a file is dragged over the window. On drop, the file is read and loaded into the editor. If the user drops **multiple files**, the drop is rejected entirely with an error toast: "Please drop one file at a time."
    - **Validation**: after reading, the file contents are parsed with the JSONC-aware parser. If invalid, the raw text is still loaded into the editor but the validation error banner appears (same as manual input errors). If the file contains comments, the editor automatically switches to JSONC mode.
    - **Size limit**: files up to **5 MB** are accepted client-side. Larger files show a toast: "File too large - max 5 MB". (Server-side save limit remains 1 MB for persisted blobs.)
    - Uploading replaces the editor contents immediately - **no confirmation prompt** even when the editor already has content. Users can recover their prior content via the editor's built-in undo (Ctrl+Z) if needed.
    - The file name is shown in a subtle label near the editor (e.g., "Loaded: config.json") until the content is manually edited.
    - **Privacy note:** file contents are read entirely client-side and never uploaded to the server unless the user explicitly saves the blob.
  - **Download as File** - a toolbar button saves the current editor content as a file to the user's device. Uses a client-side `Blob` + anchor `download` attribute - no server involvement. Default filename is the blob's title (slugified) or `jotjson-<slug>.json` for a saved blob, or `jotjson-untitled.json` for unsaved editor content. Extension is `.jsonc` when the editor is in JSONC mode (contains comments or user toggled JSONC), otherwise `.json`. Available to all users (anonymous + registered).

- **Tree View Panel** (right or bottom, depending on layout preference)
  - Renders the parsed JSON as a collapsible, interactive tree.
  - **Empty containers** render inline on a single row: empty arrays as `[]` with a `0 items` annotation, empty objects as `{}` with a `0 keys` annotation, using the same container glyph styling as non-empty containers so that an empty structure is visually distinct from a missing value.
  - Each row layout: `[expand/collapse icon]  key: value  ................  [type label]`
  - **Type labels** - right-aligned on every row, showing the JSON type with contextual counts:
    - `string` - string values.
    - `number` - numeric values.
    - `boolean` - true/false values.
    - `null` - null values.
    - `array:N` - arrays, where N is the number of direct items (e.g., `array:5`).
    - `json:X` - objects, where X is the total number of nodes in the subtree rooted at that object (recursive count of all descendant keys). E.g., a nested object containing 3 keys, one of which is itself an object with 2 keys, displays `json:5`.
  - Type labels are styled with a muted/subdued color and a small monospace font so they don't compete with the key/value content. Type labels use a single muted color rather than per-type coloring - leaf values themselves already carry semantic color (strings, numbers, booleans, null), so coloring the type badge too would be visual noise.
  - Type labels can be toggled on/off via the "Show type labels" preference in user settings.
  - **Expansion controls** (toolbar above the tree):
    - **Collapse All** button - collapses every node in the tree.
    - **Expand All** button - expands every node in the tree.
    - **Expand to Level** - a dropdown (values 1-10) that expands nodes down to the chosen depth and collapses everything deeper. E.g., "Level 2" expands the root and its immediate children but collapses grandchildren.
    - The current expansion level is displayed and persists across re-renders of the same blob.
    - Keyboard shortcuts: `Ctrl+Shift+[` (collapse all), `Ctrl+Shift+]` (expand all), `Alt+1` through `Alt+9` (expand to level N - uses Alt to avoid conflicting with browser tab shortcuts).
  - Click-to-copy path (e.g., `$.users[0].name`).
  - **Smart date/time detection** - when a string value is parseable as a date/time, the tree displays:
    - The raw original string as-is (e.g., `"2024-11-05T18:30:00Z"`).
    - Followed by a parenthetical annotation showing: the parsed date/time in the user's local format and an approximate relative time.
    - Example: `"2024-11-05T18:30:00Z"  (Nov 5, 2024, 11:30 AM PST - 1 year ago)`
    - The annotation is styled in a muted/italic font to distinguish it from the raw value.
    - Detection heuristics: ISO 8601, RFC 2822, and common formats like `YYYY-MM-DD`, `MM/DD/YYYY`. Uses a conservative parser - ambiguous strings (e.g., `"12345"`, `"hello"`) are not treated as dates. Numeric values (e.g., Unix timestamps) are **not** annotated - only string values are eligible.
    - Relative time updates live (e.g., "3 minutes ago" -> "4 minutes ago") while the page is open.
    - This feature can be toggled on/off via a tree toolbar toggle or the `treeShowDateAnnotations` user preference.
  - **Selection highlighting** - clicking a row in the tree activates three highlight layers (colors below reference the active theme's values from `TreeHighlightColors`):
    - **Selected row** - highlighted in the user's **primary selection color**. Only one row is selected at a time.
    - **Matching value rows** - all other rows whose value is identical to the selected row's value are highlighted in the **secondary color**. Matching compares the raw JSON value (type-aware: `"1"` != `1`). A small badge icon appears on each matching row to make them easy to spot.
    - **Ancestor rows** - every parent node from the selected row up to the root is highlighted in the **ancestor color**, making it easy to see the path/context of the selection.
    - Theme-appropriate defaults are defined in the `TreeHighlightColors` section of the Domain Model.
    - Registered users can override each color individually (per theme) in the **Profile -> Preferences** section via color pickers.
    - Highlights clear when clicking outside the tree or pressing `Escape`.
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

- **Layout:** Split-pane (resizable). **Horizontal** (default): editor left, tree right. **Vertical**: editor top, tree bottom. Toggled via a layout button in the toolbar or `layoutOrientation` user preference. On mobile (< 768px), always stacks vertically regardless of preference.

### 2. Persistent Link / Share  (`/s/:id`)

Available to **registered users** (create/manage). **Anonymous users can view any shared link** they have the slug for (both unlisted and public blobs).

- After submitting JSON, a registered user can click **"Save & Share"**.
- Generates a short, unique URL: `jotjson.com/s/abc123` (using the blob's NanoID slug).
- The link loads the saved JSON blob into the editor + tree view.
- **Visibility**: every saved blob is **private (unlisted) by default** - the link works for anyone who has it, but the blob is not listed on any public index, has a `noindex` meta tag, and does not emit rich Open Graph previews. The owner can toggle the blob to **public**, which enables Open Graph previews on `/s/:id` and allows indexing.
- Owner can update or delete the blob.

### 3. History & My Blobs Page  (`/history`)

Available to **registered users** only.

- Chronological list of previously submitted/viewed JSON blobs for that user.
- Each entry shows: title (or first 80 chars of JSON), date, size, actions (open, edit, delete, share, toggle public/private).
- Search and filter by date range or keyword.
- Infinite scroll (loads more entries as the user scrolls down).
- **History trigger preference**: by default, a history entry is created only on explicit save ("Save & Share"). Users can opt into recording all actions (paste, view shared link, edit) via a `historyTrackingMode` preference in Profile settings.

### 4. Auth Pages

- **Sign Up / Sign In** - handled via Microsoft Entra External ID hosted UI (redirect to Microsoft-hosted login page, customizable via External ID user flows).
- Options for v1: email + password, Google (social identity provider via External ID). GitHub may be added in a later polish step.

### 5. Profile & Settings Page  (`/profile`)

Available to **registered users** only.

- **Account Section**
  - Edit display name.
  - **Upload / change avatar** - accepts **PNG, JPEG, or WebP**; client-side validation rejects other formats. Max file size: **2 MB** (toast if exceeded). Client-side crop-to-square UI, then resize to **256x256** before upload. Stored in Azure Blob Storage, URL saved to the user profile. A "Remove avatar" option reverts to a generated default (initials on a tinted background).
  - View email address (read-only - identity managed by Entra External ID).
  - **Change password** - triggers the Entra External ID password reset flow (redirect to the self-service password reset user flow). Applies to email/password users only; hidden for social login accounts.
  - **Linked accounts** - show which social providers are connected (Google, GitHub). Allow linking/unlinking additional providers.
  - **Delete account** - confirmation dialog, then deletes user profile, all blobs, history, and rule sets. Irreversible.

- **Preferences Section** (persisted to `UserPreferences` in Cosmos DB)
  - **Theme** - dark / light / system (follows OS preference).
  - **Editor font size** - dropdown (10, 12, 14, 16, 18, 20, 22, 24px).
  - **Editor tab size** - 2 or 4 spaces.
  - **Editor word wrap** - on/off toggle.
  - **Layout orientation** - horizontal (editor left, tree right) or vertical (editor top, tree bottom). A toolbar button also provides quick toggling.
  - **Default tree expansion depth** - how many levels to auto-expand (1-10).
  - **Show type labels in tree** - toggle the type badges (string, number, etc.) on/off.
  - **Show date/time annotations** - toggle smart date detection annotations on/off.
  - **History tracking mode** - "Save only" (default) or "All actions" (records paste, view, edit events too).
  - **Default formatting rule set** - dropdown to pick a rule set to auto-apply when viewing JSON.
  - **Search defaults**:
    - **Case sensitive** - on/off (default: off).
    - **Regex mode** - on/off (default: off).
    - **Search scope** - keys only / values only / both (default: both).
  - **Blob quota strategy** - when your 100-blob cap is reached, either auto-delete the oldest blob to make room (default) or block the save with a manual prompt.
  - **Tree highlight colors (per theme)** - the dark and light themes each have their own set of four color pickers (the inactive theme's values are preserved when you switch themes):
    - Selection color (primary) - the clicked/selected row.
    - Matching value color (secondary) - rows with the same value as the selection.
    - Ancestor color - parent nodes up to the root.
    - Search highlight color - rows matching the search query.
    - A "Reset to defaults" button restores the defaults for the currently active theme.

- **Data & Privacy Section**
  - **Export my data** - enqueues a background job to generate a ZIP of all blobs, history, and rule sets. User receives a download link when ready (polled via `GET /api/me/export/:jobId`). The download URL is a pre-signed Azure Blob Storage SAS link valid for **1 hour** from generation; if it expires, the user can re-request a new export. Avoids Azure Functions timeout limits.
  - **Clear all history** - one-click purge of history entries.
  - **Clear all blobs** - delete all saved JSON blobs (with confirmation).

### 6. Landing / Marketing Elements

- Hero section on `/` (above the editor when not yet interacting): tagline, "Paste your JSON to get started" CTA.
- Footer: About, Privacy Policy, Terms, GitHub link.

### 7. Formatting Rules Page  (`/formatting-rules`)

Available to **registered users** only.

- **Rule Set Manager** - users create named rule sets (e.g., "Error Highlighter", "API Status Codes").
  - Each rule set contains one or more formatting rules.
  - Users can switch between rule sets or apply multiple simultaneously.
  - A "default" rule set is auto-applied if set by the user.

- **Rule Builder UI** - for each rule:
  - **Target:** pick whether the rule applies to keys, values, or both.
  - **Match type:** exact match, contains, starts with, ends with, or regex.
  - **Match value:** the string or pattern to match against.
  - **Case sensitivity** toggle.
  - **Style picker:** visual controls for:
    - Background color (color swatch picker).
    - Text color.
    - Bold / italic / underline toggles.
    - Border/outline color.
    - Optional icon badge (warning, check, star, etc.).
  - **Live preview** - a sample JSON snippet updates in real time as the user configures the rule, showing how matches will look.

- **How it works in the Tree View:**
  - When a rule set is active, the tree view scans each node's key and value.
  - Matching nodes receive the configured inline styles (background, text color, font weight, etc.).
  - Multiple rules can match the same node - styles are merged in rule-list order (later rules override earlier ones for conflicting properties).
  - A tooltip on hover shows which rule(s) matched a given node (keeps the tree visually clean).
  - **Highlight priority** (highest to lowest): selection highlight -> matching-value highlight -> ancestor highlight -> search highlight -> formatting rules. Higher-priority highlights suppress lower-priority ones on the same row.
  - A **formatting toolbar** above the tree view lets users quickly toggle rule sets on/off or pick which set to apply.

- **Built-in Presets** - ship a few starter rule sets users can clone and customize:
  - "Error Detection" - highlights keys like `error`, `err`, `exception`, `fault` in red.
  - "Status Codes" - color-codes values like `200` (green), `400` (yellow), `500` (red).
  - "Null Finder" - highlights all `null` values with a yellow background.

- **Limits (free tier):** max 20 rule sets per user, max 50 rules per rule set.

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
   - **History & My Blobs**: all saved blobs appear in `/history` with full management (edit, delete, share, toggle public/private).
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

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/blobs` | Required | Create a new JSON blob |
| GET | `/api/blobs/:id` | Optional* | Get a blob by UUID or slug (*no auth required for private/unlisted or public blobs; owner auth only needed for blobs explicitly set to owner-only, a post-v1 feature) |
| PUT | `/api/blobs/:id` | Required (owner) | Update a blob |
| DELETE | `/api/blobs/:id` | Required (owner) | Delete a blob |
| GET | `/api/blobs` | Required | List user's blobs (paginated) |
| GET | `/api/history` | Required | Get user's history (paginated) |
| DELETE | `/api/history` | Required | Clear history |
| GET | `/api/me` | Required | Get current user profile |
| PUT | `/api/me` | Required | Update display name, avatar |
| PUT | `/api/me/preferences` | Required | Update user preferences |
| POST | `/api/me/export` | Required | Enqueue data export job (returns job ID) |
| GET | `/api/me/export/:jobId` | Required | Poll export job status; returns ZIP download URL when complete |
| DELETE | `/api/me` | Required | Delete account and all associated data |
| POST | `/api/rule-sets` | Required | Create a formatting rule set |
| GET | `/api/rule-sets` | Required | List user's rule sets |
| GET | `/api/rule-sets/:id` | Required (owner) | Get a rule set by ID |
| PUT | `/api/rule-sets/:id` | Required (owner) | Update a rule set |
| DELETE | `/api/rule-sets/:id` | Required (owner) | Delete a rule set |
| GET | `/api/rule-sets/presets` | Required | List built-in preset rule sets |
| POST | `/api/rule-sets/presets/:id/clone` | Required | Clone a preset into user's rule sets |

### Validation Rules
- Max blob size: **1 MB** (free tier).
- Must be valid JSON or JSONC (server re-validates using JSONC-aware parser).
- Rate limiting: 60 requests/min per IP (anonymous), 120/min (authenticated).
- **Blob quota (free tier: 100 blobs per user)** - when a user saves their 101st blob, the server automatically deletes the **oldest** blob (by `updatedAt`, then `createdAt` as tiebreaker) to make room. The user is notified via a toast: "Deleted oldest blob '[title]' to stay within your 100-blob limit." The first time this happens per user, a one-time modal explains the auto-delete behavior and offers "OK, got it" or "Let me manage manually" (which instead aborts the save with a prompt to delete blobs from `/history`). This choice is remembered as a user preference (`blobQuotaStrategy`: `"auto_fifo"` default or `"manual"`).

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
- CORS: allow only `jotjson.com` origins.
- Content Security Policy headers.

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
- **Web App Manifest** (`manifest.webmanifest`):
  - `name`: "JotJSON", `short_name`: "JotJSON"
  - `display`: `standalone` (runs without browser chrome).
  - `start_url`: `/`
  - `theme_color` and `background_color` matching the app's dark/light theme.
  - Icons at standard sizes: 192x192, 512x512 (maskable + any).
  - `categories`: `["developer-tools", "utilities"]`
  - `screenshots`: at least one wide and one narrow for richer install prompts.
- **Service Worker** (using Angular's `@angular/service-worker`):
  - Caches the app shell (HTML, CSS, JS, fonts, icons) for offline loading.
  - Offline mode: the editor and tree view work fully offline with `localStorage` data. API-dependent features (save, share, history, formatting rules) show a "You're offline" banner and queue actions for sync when reconnected.
  - Cache-first strategy for static assets; network-first for API calls.
  - Background sync for queued blob saves when connectivity is restored.
  - Automatic update prompt: when a new version is deployed, users see a non-intrusive toast ("A new version is available - click to refresh").
- **Install prompt**: a subtle "Install JotJSON" button in the toolbar/header, shown when the browser fires the `beforeinstallprompt` event. Hidden once installed.

---

## UI/UX Guidelines

- **Theme:** Clean, developer-friendly. Dark mode default with light mode toggle.
- **Typography:** Monospace font for JSON content (e.g., JetBrains Mono, Fira Code). Sans-serif for UI chrome.
- **Color Palette:**
  - Primary: Teal/Cyan accent (#00BCD4 family).
  - Background: Dark (#1E1E1E) / Light (#FAFAFA).
  - JSON types color-coded: strings=green, numbers=orange, booleans=blue, null=gray.
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

```
src/
├── app/
│   ├── core/                  # Singleton services, guards, interceptors
│   │   ├── auth/              # MSAL config, auth guard, auth service
│   │   ├── api/               # HTTP services (BlobService, HistoryService)
│   │   └── interceptors/      # Auth token interceptor, error interceptor
│   ├── shared/                # Reusable components, pipes, directives
│   │   ├── components/
│   │   │   ├── json-editor/   # Code editor wrapper component
│   │   │   ├── json-tree/     # Recursive tree view component
│   │   │   └── toolbar/       # Action buttons (format, minify, copy, share)
│   │   └── pipes/
│   │       └── json-type.pipe.ts
│   ├── features/
│   │   ├── home/              # Main editor + tree view page
│   │   ├── share/             # /s/:id persistent link viewer
│   │   ├── history/           # /history page
│   │   ├── formatting-rules/  # /formatting-rules - rule set manager + rule builder
│   │   └── profile/           # /profile page
│   ├── app.component.ts
│   ├── app.routes.ts
│   └── app.config.ts
├── assets/
├── environments/
│   ├── environment.ts
│   └── environment.prod.ts
└── styles/
    ├── _variables.scss
    ├── _theme.scss
    └── styles.scss
```

---

## Azure Infrastructure (IaC - Bicep)

| Resource | SKU / Tier | Notes |
|---|---|---|
| Azure Static Web Apps | Free (dev) -> Standard (launch) | Hosts SPA + proxies to Functions. Start Free, upgrade to Standard before launch for SLA + 5 GB storage. |
| Azure Functions | Consumption | Serverless API |
| Cosmos DB | Serverless | Database: `jotjson`. Containers + partition keys: `blobs` (partitionKey: `/ownerId`), `users` (`/id`), `history` (`/userId`), `rule-sets` (`/userId`) |
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
  - Lint (ESLint), unit tests (Karma/Jest), build (`ng build --configuration production`).
  - Azure Functions: lint, test, build.
- **CD pipeline** - deploys on merge to `main`:
  - Angular SPA -> Azure Static Web Apps (using the `azure/static-web-apps-deploy` action).
  - Azure Functions -> deployed as Static Web Apps managed functions (bundled with the SPA in a single deployment).
  - Staging slot for preview on PRs (Static Web Apps preview environments).
- **Infrastructure** - Bicep templates applied via a separate workflow on changes to `/infra` directory.

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
5. **History** - History tracking, `/history` page, management actions.
6. **Formatting rules** - Rule set CRUD API, rule builder UI, tree view integration, built-in presets.
7. **Polish & launch** - Each of these lands as its own step/commit:
   - ~~**M7a**: Smart clipboard polling + banner prompt for the Paste button (Home page §1).~~ (done)
   - **M7b**: Drag-and-drop file upload with full-page drop overlay (Home page §1).
   - **M7c**: Smart date/time detection + relative-time annotations in the tree view (Home page §1).
   - **M7d**: Selection highlighting (selected row + matching-value rows + ancestor chain) in the tree view (Home page §1).
   - ~~**M7e**: Custom domain (`jotjson.com`).~~ (done)
   - **M7f**: Dark/light theme polish.
   - **M7g**: Accessibility audit.
   - **M7h**: SEO (pre-rendering + OG tags).
   - **M7i**: Monitoring (App Insights dashboards & alerts).
   - **M7j**: Static Web Apps upgrade to Standard tier.
   - **M7k**: Surface JSONC comments in the tree view (e.g., attach leading/trailing comments from `jsonc-parser` to the nearest node and render them as dimmed annotations or a hover affordance).
   - **M7l**: Responsive layout - on viewports narrower than 768px, force the editor/tree split to stack vertically (editor on top, tree below) regardless of the user's `layoutOrientation` preference, per Home page §Layout. Also collapse the status bar (M7m) to a single-line summary - keep Bytes, Lines, and Mode; hide cursor, nodes, depth, and object/array counts.
   - ~~**M7m**: Status bar - a slim, always-visible strip along the bottom of the Home page that surfaces at-a-glance stats about the current document. Left cluster covers the raw text (character count, line count, byte size in UTF-8, current cursor line/column); right cluster covers the parsed tree (total node count, max depth, array vs. object counts, JSON vs. JSONC mode indicator). Stats update reactively as the user types. Hidden or collapsed to a single-line summary on narrow viewports (see M7l). No interactivity required in v1 - purely informational.~~ (done)
   - **M7n**: Version & commit surfacing - replace the short-term `dev`/local-git SHA indicator with a CI-authoritative version badge. Build tooling injects `{ version, sha, builtAt, branch }` from `package.json` + `GITHUB_SHA` / `GITHUB_REF_NAME` env vars into a generated module (no local `git` dependency). Status bar (right cluster, after the mode badge) shows `vX.Y.Z - abc1234`, clickable to copy the full SHA to the clipboard and linking to the corresponding commit on GitHub. Also emit a one-line `console.info` banner on app start so the version lands in bug-report consoles. Release discipline: bump `package.json` `version` on user-visible releases (via `npm version`). Future follow-up (not part of this step): a `GET /api/version` endpoint so the frontend can also surface the backend SHA and flag skew.

---

## Open Questions / Future Considerations

- **Collaboration:** Real-time collaborative editing (future - would need SignalR/WebSockets).
- **JSON Schema validation:** Let users supply a schema and validate blobs against it.
- **Diff view:** Compare two JSON blobs side-by-side.
- **Bulk export/import:** Export/import `.json` files in bulk (single-blob download is in v1).
- **API access:** Provide API keys for programmatic blob storage (developer tier).
- **Monetization:** Pro plan with higher limits (larger blobs, more storage, **owner-only blobs** where the slug alone isn't enough to view, custom slugs).
