# JotJSON — Design Specification

## Overview

**JotJSON** (jotjson.com) is a web application for inputting, storing, and displaying JSON and JSONC (JSON with Comments). Users paste or type raw JSON or JSONC, and the site renders it as an interactive tree view. The app works without an account, but registered users unlock persistent links and submission history.

**Stack:** Angular frontend, Azure hosting (Static Web Apps + related services).

---

## Architecture

### Frontend — Angular SPA

| Layer | Technology |
|---|---|
| Framework | Angular (latest LTS) |
| UI Component Library | Angular Material |
| JSON Tree View | Custom component (recursive tree built on Angular CDK Tree or `mat-tree`) |
| State Management | Angular Signals / lightweight service-based state |
| Routing | Angular Router (lazy-loaded feature modules) |
| Auth | MSAL Angular (@azure/msal-angular) for Azure AD B2C |

### Backend — Azure

| Service | Purpose |
|---|---|
| Azure Static Web Apps | Host the Angular SPA (with built-in Azure Functions proxy) |
| Azure Functions (Node/TypeScript) | Serverless API layer |
| Azure Cosmos DB (NoSQL, serverless tier) | Store JSON blobs, user profiles, history |
| Azure AD B2C | Identity provider (email/password + social logins) |
| Azure CDN / Front Door | *(deferred to post-v1)* — add for WAF and advanced routing if needed. v1 uses Static Web Apps' built-in CDN and custom domain support. |
| Azure Blob Storage | Storage for user avatars and large JSON blob overflow |

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
                        └──▶ Azure AD B2C     (auth tokens)
```

---

## Domain Model

### Entities

#### JsonBlob
```
{
  id: string (UUID — internal primary key),
  slug: string (NanoID short-id, 6 characters, e.g., "a3Bf9x" — used in public URLs, unique with collision check),
  content: string (raw JSON text),
  title?: string,
  createdAt: DateTime,
  updatedAt: DateTime,
  ownerId?: string (null for anonymous),
  isPublic: boolean,
  expiresAt?: DateTime (auto-expire for anonymous blobs)
}
```

#### User
```
{
  id: string (Azure AD B2C object ID),
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
  editorFontSize: number (default: 14, range: 10–24),
  editorTabSize: number (default: 2, range: 2 | 4),
  defaultTreeExpansionDepth: number (default: 3, range: 1–10),
  defaultRuleSetId?: string (auto-apply this rule set on load),
  editorWordWrap: boolean (default: false),
  treeShowTypeLabels: boolean (default: true),
  treeShowDateAnnotations: boolean (default: true),
  historyTrackingMode: "save_only" | "all_actions" (default: "save_only"),
  treeHighlightColors: TreeHighlightColors
}
```

#### TreeHighlightColors
```
{
  selectionColor: string,          # primary — the selected row (default: "#264F78", a muted blue)
  matchingValueColor: string,      # secondary — other rows with the same value (default: "#3E3D32", a warm gray)
  ancestorColor: string,           # parent chain — all ancestors of the selected node (default: "#2A2D2E", a subtle dark highlight)
  searchHighlightColor: string     # search matches — rows matching the search query (default: "#6A4C00", a muted amber/gold)
}
```

#### HistoryEntry
```
{
  id: string,
  userId: string,
  blobId: string,
  accessedAt: DateTime,
  action: "created" | "viewed" | "edited"
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

### 1. Home / Editor Page  (`/`)

The primary page. Available to **all users** (anonymous + registered).

- **JSON Input Panel** (left or top)
  - Monaco Editor for syntax highlighting, line numbers, error markers, and JSON/JSONC-specific IntelliSense. Loaded lazily to offset its ~2 MB bundle size. Editor language mode auto-detects JSON vs JSONC based on content (presence of `//` or `/* */` comments) and can be toggled manually via a **JSON / JSONC** switch in the toolbar.
  - **JSONC support**: the editor and parser accept JSON with Comments (single-line `//` and multi-line `/* */`), as well as trailing commas. Comments are stripped before parsing into the tree view but preserved in the raw editor text. When saving a blob, the original text (with comments) is stored; the parsed tree is derived on load. This uses a JSONC-aware parser (e.g., `jsonc-parser` from the VS Code ecosystem) rather than native `JSON.parse`.
  - "Paste JSON from Clipboard", "Upload File", "Clear", "Format / Pretty-Print", and "Minify" action buttons.
  - Real-time JSON validation with inline error messages (line + column of parse error).
  - **Smart Paste Button** behavior:
    - On page load (and periodically while the page is focused), the app reads the clipboard using the **Clipboard API** (`navigator.clipboard.readText()`).
    - The browser will prompt the user for clipboard permission on first access. The app should request this permission early — on first interaction or via a clear prompt (e.g., "Allow clipboard access to enable one-click paste"). If the user denies permission, the button is hidden and standard `Ctrl+V` paste still works normally.
    - The clipboard contents are tested with a lightweight parse attempt (JSONC-aware parser). If the text is valid JSON or JSONC (or starts with `{` or `[` and is plausibly JSON), the **"Paste JSON from Clipboard"** button is **enabled** with a green/active state and a tooltip showing a preview of the first ~80 characters.
    - If the clipboard does not contain JSON-like text, the button is **disabled/grayed out** with a tooltip: "Clipboard does not contain JSON".
    - Clicking the enabled button replaces the editor contents with the clipboard JSON and triggers the tree view to render.
    - The clipboard check runs: (1) on page/tab focus, (2) when the user clicks into the editor panel, and (3) on a short polling interval (~2 seconds) while the page is visible. Polling stops when the tab is backgrounded (using `document.visibilityState`).
    - **Fallback for restricted browsers:** if the browser denies clipboard polling (some require a user gesture), the button remains always visible in an "unknown" state. Clicking it triggers a user-gesture clipboard read — if the content is valid JSON, it pastes immediately; if not, a brief tooltip says "Clipboard does not contain JSON". This ensures the feature works even without polling permission.
    - **Privacy note:** clipboard contents are never sent to the server — the check is entirely client-side.
  - **File Upload** — two ways to load a JSON file:
    - **Toolbar button** ("Upload File"): opens a native file picker filtered to `.json`, `.jsonc`, `.jsonl`, `.geojson`, and `.txt` extensions. Reads the selected file client-side via the `FileReader` API and loads its contents into the editor.
    - **Drag & drop**: users can drag a file from their desktop onto **any part of the page**. A full-page drop zone overlay appears with a visual cue (dashed border + "Drop JSON file here" message) when a file is dragged over the window. On drop, the file is read and loaded into the editor.
    - **Validation**: after reading, the file contents are parsed with the JSONC-aware parser. If invalid, the raw text is still loaded into the editor but the validation error banner appears (same as manual input errors). If the file contains comments, the editor automatically switches to JSONC mode.
    - **Size limit**: files up to **5 MB** are accepted client-side. Larger files show a toast: "File too large — max 5 MB". (Server-side save limit remains 1 MB for persisted blobs.)
    - If the editor already has content, a confirmation prompt asks: "Replace current JSON with uploaded file?" with Replace / Cancel options.
    - The file name is shown in a subtle label near the editor (e.g., "Loaded: config.json") until the content is manually edited.
    - **Privacy note:** file contents are read entirely client-side and never uploaded to the server unless the user explicitly saves the blob.

- **Tree View Panel** (right or bottom)
  - Renders the parsed JSON as a collapsible, interactive tree.
  - Each row layout: `[expand/collapse icon]  key: value  ................  [type label]`
  - **Type labels** — right-aligned on every row, showing the JSON type with contextual counts:
    - `string` — string values.
    - `number` — numeric values.
    - `boolean` — true/false values.
    - `null` — null values.
    - `array:N` — arrays, where N is the number of direct items (e.g., `array:5`).
    - `json:X` — objects, where X is the total number of nodes in the subtree rooted at that object (recursive count of all descendant keys). E.g., a nested object containing 3 keys, one of which is itself an object with 2 keys, displays `json:5`.
  - Type labels are styled with a muted/subdued color and a small monospace font so they don't compete with the key/value content. Each type has a distinct color (consistent with the color palette: strings=green, numbers=orange, booleans=blue, null=gray, array=purple, json=teal).
  - Type labels can be toggled on/off via the "Show type labels" preference in user settings.
  - **Expansion controls** (toolbar above the tree):
    - **Collapse All** button — collapses every node in the tree.
    - **Expand All** button — expands every node in the tree.
    - **Expand to Level** — a dropdown or numeric stepper (1–10) that expands nodes down to the chosen depth and collapses everything deeper. E.g., "Level 2" expands the root and its immediate children but collapses grandchildren.
    - The current expansion level is displayed and persists across re-renders of the same blob.
    - Keyboard shortcuts: `Ctrl+Shift+[` (collapse all), `Ctrl+Shift+]` (expand all), `Alt+1` through `Alt+9` (expand to level N — uses Alt to avoid conflicting with browser tab shortcuts).
  - Click-to-copy path (e.g., `$.users[0].name`).
  - **Smart date/time detection** — when a string value is parseable as a date/time, the tree displays:
    - The raw original string as-is (e.g., `"2024-11-05T18:30:00Z"`).
    - Followed by a parenthetical annotation showing: the parsed date/time in the user's local format and an approximate relative time.
    - Example: `"2024-11-05T18:30:00Z"  (Nov 5, 2024, 11:30 AM PST — 1 year ago)`
    - The annotation is styled in a muted/italic font to distinguish it from the raw value.
    - Detection heuristics: ISO 8601, RFC 2822, and common formats like `YYYY-MM-DD`, `MM/DD/YYYY`. Uses a conservative parser — ambiguous strings (e.g., `"12345"`, `"hello"`) are not treated as dates. Numeric values (e.g., Unix timestamps) are **not** annotated — only string values are eligible.
    - Relative time updates live (e.g., "3 minutes ago" → "4 minutes ago") while the page is open.
    - This feature can be toggled on/off via a tree toolbar toggle or the `treeShowDateAnnotations` user preference.
  - **Selection highlighting** — clicking a row in the tree activates three highlight layers:
    - **Selected row** — highlighted in the user's **primary selection color** (default: muted blue `#264F78`). Only one row is selected at a time.
    - **Matching value rows** — all other rows whose value is identical to the selected row's value are highlighted in the **secondary color** (default: warm gray `#3E3D32`). Matching compares the raw JSON value (type-aware: `"1"` ≠ `1`). A subtle badge or count (e.g., "3 matches") appears near the selected row.
    - **Ancestor rows** — every parent node from the selected row up to the root is highlighted in the **ancestor color** (default: subtle dark `#2A2D2E`), making it easy to see the path/context of the selection.
    - All three colors have sensible defaults that work well in both dark and light themes (auto-adjusted per theme).
    - Registered users can override each color individually in the **Profile → Preferences** section via color pickers.
    - Highlights clear when clicking outside the tree or pressing `Escape`.
  - **Search highlight** — a persistent search field is positioned near the top of the tree view panel (above or alongside the expansion controls):
    - User types arbitrary text into the search field; matching is **live** as they type (debounced ~150ms).
    - Any row whose key or value contains the search text (case-insensitive by default) is highlighted in the **search highlight color** (default: muted amber/gold `#6A4C00`).
    - The matched substring within the key or value text is **bold** or has an inline background highlight so users can see exactly what matched.
    - A match count is displayed next to the search field (e.g., "12 matches").
    - **Previous / Next** navigation buttons (and `Enter` / `Shift+Enter` shortcuts) jump between matches, auto-expanding collapsed parent nodes as needed and scrolling the match into view.
    - **Highlight priority**: if a row is both a search match and has a selection/matching-value/ancestor highlight, the selection highlights take precedence and the search highlight is suppressed for that row (avoiding visual noise).
    - Options available via small toggles next to the search field: **case sensitive**, **regex mode**, **keys only / values only / both**.
    - Clearing the search field (or pressing `Escape` while focused in it) removes all search highlights.
    - The search field is always visible — it does not need to be toggled open.
    - Keyboard shortcut: `Ctrl+F` is **context-aware** — when the editor panel is focused, it triggers Monaco's built-in find; when the tree panel is focused (or no panel is focused), it focuses the tree search field.

- **Layout:** Split-pane (resizable) — editor on one side, tree on the other. Responsive: stacks vertically on mobile.

### 2. Persistent Link / Share  (`/s/:id`)

Available to **registered users** (create/manage). **Anonymous users can view** public shared links.

- After submitting JSON, a registered user can click **"Save & Share"**.
- Generates a short, unique URL: `jotjson.com/s/abc123` (using the blob's NanoID slug).
- The link loads the saved JSON blob into the editor + tree view.
- Owner can update or delete the blob.
- Optional: set blob to public (viewable by anyone with the link) or private (owner only).

### 3. History & My Blobs Page  (`/history`)

Available to **registered users** only.

- Chronological list of previously submitted/viewed JSON blobs for that user.
- Each entry shows: title (or first 80 chars of JSON), date, size, actions (open, edit, delete, share, toggle public/private).
- Search and filter by date range or keyword.
- Pagination or infinite scroll.
- **History trigger preference**: by default, a history entry is created only on explicit save ("Save & Share"). Users can opt into recording all actions (paste, view shared link, edit) via a `historyTrackingMode` preference in Profile settings.

### 4. Auth Pages

- **Sign Up / Sign In** — handled via Azure AD B2C hosted UI or embedded MSAL redirect.
- Options: email + password, Google, GitHub (social identity providers via B2C).

### 5. Profile & Settings Page  (`/profile`)

Available to **registered users** only.

- **Account Section**
  - Edit display name.
  - Upload / change avatar (stored in Azure Blob Storage, URL saved to user profile).
  - View email address (read-only — identity managed by Azure AD B2C).
  - **Change password** — triggers the Azure AD B2C password reset flow (redirect to B2C's self-service password reset policy). Applies to email/password users only; hidden for social login accounts.
  - **Linked accounts** — show which social providers are connected (Google, GitHub). Allow linking/unlinking additional providers.
  - **Delete account** — confirmation dialog, then deletes user profile, all blobs, history, and rule sets. Irreversible.

- **Preferences Section** (persisted to `UserPreferences` in Cosmos DB)
  - **Theme** — dark / light / system (follows OS preference).
  - **Editor font size** — slider or dropdown (10–24px).
  - **Editor tab size** — 2 or 4 spaces.
  - **Editor word wrap** — on/off toggle.
  - **Default tree expansion depth** — how many levels to auto-expand (1–10).
  - **Show type labels in tree** — toggle the type badges (string, number, etc.) on/off.
  - **Show date/time annotations** — toggle smart date detection annotations on/off.
  - **History tracking mode** — "Save only" (default) or "All actions" (records paste, view, edit events too).
  - **Default formatting rule set** — dropdown to pick a rule set to auto-apply when viewing JSON.
  - **Tree highlight colors** — four color pickers to customize:
    - Selection color (primary) — the clicked/selected row.
    - Matching value color (secondary) — rows with the same value as the selection.
    - Ancestor color — parent nodes up to the root.
    - Search highlight color — rows matching the search query.
    - A "Reset to defaults" button restores theme-appropriate colors.

- **Data & Privacy Section**
  - **Export my data** — enqueues a background job to generate a ZIP of all blobs, history, and rule sets. User receives a download link when ready (polled via `GET /api/me/export/:jobId`). Avoids Azure Functions timeout limits.
  - **Clear all history** — one-click purge of history entries.
  - **Clear all blobs** — delete all saved JSON blobs (with confirmation).

### 6. Landing / Marketing Elements

- Hero section on `/` (above the editor when not yet interacting): tagline, "Paste your JSON to get started" CTA.
- Footer: About, Privacy Policy, Terms, GitHub link.

### 7. Formatting Rules Page  (`/formatting-rules`)

Available to **registered users** only.

- **Rule Set Manager** — users create named rule sets (e.g., "Error Highlighter", "API Status Codes").
  - Each rule set contains one or more formatting rules.
  - Users can switch between rule sets or apply multiple simultaneously.
  - A "default" rule set is auto-applied if set by the user.

- **Rule Builder UI** — for each rule:
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
  - **Live preview** — a sample JSON snippet updates in real time as the user configures the rule, showing how matches will look.

- **How it works in the Tree View:**
  - When a rule set is active, the tree view scans each node's key and value.
  - Matching nodes receive the configured inline styles (background, text color, font weight, etc.).
  - Multiple rules can match the same node — styles are merged in rule-list order (later rules override earlier ones for conflicting properties).
  - A small indicator badge or tooltip shows which rule(s) matched a given node.
  - **Highlight priority** (highest to lowest): selection highlight → matching-value highlight → ancestor highlight → search highlight → formatting rules. Higher-priority highlights suppress lower-priority ones on the same row.
  - A **formatting toolbar** above the tree view lets users quickly toggle rule sets on/off or pick which set to apply.

- **Built-in Presets** — ship a few starter rule sets users can clone and customize:
  - "Error Detection" — highlights keys like `error`, `err`, `exception`, `fault` in red.
  - "Status Codes" — color-codes values like `200` (green), `400` (yellow), `500` (red).
  - "Null Finder" — highlights all `null` values with a yellow background.

- **Limits (free tier):** max 20 rule sets per user, max 50 rules per rule set.

---

## User Flows

### Anonymous User
1. Lands on `jotjson.com`.
2. Pastes or types JSON into the editor.
3. Tree view renders in real time.
4. Can format, minify, copy output.
5. If they try to "Save & Share" or view history → prompted to create an account.
6. Session data (current JSON) stored in browser `localStorage` so it persists across refreshes.

### Registered User
1. Signs in via Azure AD B2C.
2. All anonymous features plus:
   - **Save & Share**: persists the blob to Cosmos DB, generates a shareable link.
   - **History & My Blobs**: all saved blobs appear in `/history` with full management (edit, delete, share, toggle public/private).
   - **Formatting Rules**: create custom highlighting rules that auto-apply to the tree view.
3. Session state syncs to server.

---

## API Design (Azure Functions)

Base path: `https://api.jotjson.com/` (or `/api/` proxied via Static Web Apps)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/blobs` | Required | Create a new JSON blob |
| GET | `/api/blobs/:id` | Optional* | Get a blob by UUID or slug (*public blobs accessible without auth) |
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

---

## Non-Functional Requirements

### Performance
- Tree view should render blobs up to **5 MB** without freezing the UI (use virtual scrolling for large trees).
- Time-to-interactive < 2 seconds on 4G connection.
- API response time < 200ms (p95) for blob CRUD.

### Security
- All traffic over HTTPS (enforced by Azure Static Web Apps' built-in SSL).
- Azure AD B2C handles all credential storage — no passwords in Cosmos DB.
- Input sanitization: JSON blobs are treated as opaque strings, never rendered as HTML.
- CORS: allow only `jotjson.com` origins.
- Content Security Policy headers.

### Scalability
- Cosmos DB serverless scales automatically.
- Azure Functions consumption plan scales to zero when idle.
- CDN caches static assets aggressively.

### Reliability
- Anonymous blobs auto-expire after **30 days** (TTL in Cosmos DB).
- Registered user blobs persist indefinitely (free tier: up to 100 blobs).
- Cosmos DB automatic backups.

### Accessibility
- WCAG 2.1 AA compliance.
- Keyboard-navigable tree view.
- Screen-reader-friendly labels.

### SEO / Social
- Server-side rendering or pre-rendering for `/` landing page.
- Open Graph tags for shared blob links (`/s/:id`) — show preview of JSON structure.

### Progressive Web App (PWA)
- The site is installable as a **browser app** (PWA) on desktop and mobile.
- **Web App Manifest** (`manifest.webmanifest`):
  - `name`: "JotJSON", `short_name`: "JotJSON"
  - `display`: `standalone` (runs without browser chrome).
  - `start_url`: `/`
  - `theme_color` and `background_color` matching the app's dark/light theme.
  - Icons at standard sizes: 192×192, 512×512 (maskable + any).
  - `categories`: `["developer-tools", "utilities"]`
  - `screenshots`: at least one wide and one narrow for richer install prompts.
- **Service Worker** (using Angular's `@angular/service-worker`):
  - Caches the app shell (HTML, CSS, JS, fonts, icons) for offline loading.
  - Offline mode: the editor and tree view work fully offline with `localStorage` data. API-dependent features (save, share, history, formatting rules) show a "You're offline" banner and queue actions for sync when reconnected.
  - Cache-first strategy for static assets; network-first for API calls.
  - Background sync for queued blob saves when connectivity is restored.
  - Automatic update prompt: when a new version is deployed, users see a non-intrusive toast ("A new version is available — click to refresh").
- **Install prompt**: a subtle "Install JotJSON" button in the toolbar/header, shown when the browser fires the `beforeinstallprompt` event. Hidden once installed.

---

## UI/UX Guidelines

- **Theme:** Clean, developer-friendly. Dark mode default with light mode toggle.
- **Typography:** Monospace font for JSON content (e.g., JetBrains Mono, Fira Code). Sans-serif for UI chrome.
- **Color Palette:**
  - Primary: Teal/Cyan accent (#00BCD4 family).
  - Background: Dark (#1E1E1E) / Light (#FAFAFA).
  - JSON types color-coded: strings=green, numbers=orange, booleans=blue, null=gray.
- **Logo:** "JotJSON" wordmark — "Jot" in regular weight, "JSON" in bold, with a `{ }` icon element.
- **Responsive breakpoints:** Mobile (< 768px), Tablet (768–1024px), Desktop (> 1024px).

### Error, Loading & Empty States

- **Loading skeletons:** show pulsing placeholder blocks while API data loads (history list, blob fetch, rule sets). The editor + tree view render instantly from local state.
- **Error toasts:** non-blocking toast notifications (bottom-right, auto-dismiss after 5 seconds) for API errors, save failures, and network issues. Include a "Retry" action where applicable.
- **404 page:** friendly "Blob not found" page for invalid `/s/:id` links, with a CTA to go to the editor. Similarly, a generic 404 for unknown routes.
- **Offline banner:** persistent banner at the top of the page when network is unavailable (detected via `navigator.onLine` + service worker). Dismisses automatically when connectivity returns.
- **Empty states:** contextual illustrations + messages for:
  - History page with no entries: "No history yet — paste some JSON to get started."
  - No saved blobs: "You haven't saved any JSON blobs yet."
  - No formatting rule sets: "Create your first rule set to highlight JSON your way."
  - Search with no matches: "No matches found for '…'"
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
│   │   ├── formatting-rules/  # /formatting-rules — rule set manager + rule builder
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

## Azure Infrastructure (IaC — Bicep)

| Resource | SKU / Tier | Notes |
|---|---|---|
| Azure Static Web Apps | Free (dev) → Standard (launch) | Hosts SPA + proxies to Functions. Start Free, upgrade to Standard before launch for SLA + 5 GB storage. |
| Azure Functions | Consumption | Serverless API |
| Cosmos DB | Serverless | Database: `jotjson`. Containers + partition keys: `blobs` (partitionKey: `/ownerId`), `users` (`/id`), `history` (`/userId`), `rule-sets` (`/userId`) |
| Azure AD B2C | Free (50k MAU) | Identity |
| Azure Blob Storage | Standard LRS | User avatars + large blob overflow |
| Azure Front Door | *(deferred post-v1)* | Add for WAF / advanced routing if needed |
| Azure Monitor / App Insights | Pay-as-you-go | Logging, telemetry |

---

## CI/CD (GitHub Actions)

- **CI pipeline** — runs on every push and PR:
  - Lint (ESLint), unit tests (Karma/Jest), build (`ng build --configuration production`).
  - Azure Functions: lint, test, build.
- **CD pipeline** — deploys on merge to `main`:
  - Angular SPA → Azure Static Web Apps (using the `azure/static-web-apps-deploy` action).
  - Azure Functions → deployed via Static Web Apps managed functions or separate Functions deploy action.
  - Staging slot for preview on PRs (Static Web Apps preview environments).
- **Infrastructure** — Bicep templates applied via a separate workflow on changes to `/infra` directory.

---

## Milestones

1. **Project scaffolding** — Angular app, Azure Functions project, Cosmos DB setup, CI/CD pipeline.
2. **Core editor experience** — JSON input + tree view on `/`, localStorage persistence, no auth.
3. **Auth integration** — Azure AD B2C sign-up/sign-in, MSAL Angular, protected routes.
4. **Persistent links** — Blob CRUD API, save & share flow, `/s/:id` route.
5. **History** — History tracking, `/history` page, management actions.
6. **Formatting rules** — Rule set CRUD API, rule builder UI, tree view integration, built-in presets.
7. **Polish & launch** — Custom domain, CDN, dark/light theme, accessibility audit, SEO, monitoring.

---

## Open Questions / Future Considerations

- **Collaboration:** Real-time collaborative editing (future — would need SignalR/WebSockets).
- **JSON Schema validation:** Let users supply a schema and validate blobs against it.
- **Diff view:** Compare two JSON blobs side-by-side.
- **Import/Export:** Export JSON blobs to `.json` files (download button).
- **API access:** Provide API keys for programmatic blob storage (developer tier).
- **Monetization:** Pro plan with higher limits (larger blobs, more storage, private blobs, custom slugs).
