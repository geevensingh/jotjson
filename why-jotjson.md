# Why JotJSON?

**JotJSON** ([jotjson.com](https://jotjson.com)) does the obvious things every
JSON tool does - format, minify, validate, search, tree view - and a stack of
less-obvious things that no other JSON tool does. This doc is about the
latter.

---

## Things you can't get elsewhere

These are features that competing online JSON tools (jsoncrack, jsonhero,
jsoneditoronline, jsonformatter.org, code beautifiers) either don't have or
only do partially.

### Find JSON hiding inside your JSON

Real-world API responses often look like this:

```json
{ "status": "ok", "body": "{\"userId\":42,\"prefs\":{\"theme\":\"dark\"}}" }
```

Other tools render `body` as one long unreadable escaped string. JotJSON
spots that the string itself contains JSON, surfaces a small **Extract**
pill on the row, and one click splices the parsed structure back into the
tree. If the embedded JSON is wrapped in prose (a log line, a `curl -v`
transcript), the result preserves the prose under `prefix` / `suffix` keys
so nothing gets lost. Every string leaf in the document is scanned in a
background worker - not just the top-level paste.

### Extract JSON from logs and mixed text on paste

Pasted a `curl -v` output? A log line with a payload glued to it? A stack
trace with a JSON body? JotJSON scans the buffer for embedded `{...}` and
`[...]` blocks and shows a non-destructive banner: **[Extract embedded
JSON]** / **[Dismiss]**. Your raw paste stays in the editor either way.
A bare block extracts to the block; surrounding prose is preserved
under `prefix` / `suffix` / `between_<i>_and_<j>` keys so log headers,
HTTP request lines, and trailing operation names don't get lost.

### Auto-unescape on paste (and copy back)

Pasted `{\"a\":1}` (out of a debugger, a log, a database column) doesn't
parse as JSON. JotJSON quietly tries unescaping it; if the result is a
clean object or array, it loads the unescaped version and formats it.
Ctrl+Z gets you back the raw paste. The inverse - **Copy as escaped
string** - is available with Alt+click on any copy action, completing the
round-trip you usually have to do by hand.

### Decoded value viewer for escaped strings

Strings with embedded `\n`, `\t`, or `\"` are hard to read in their
JSON-escaped form, and very long single-line values (URLs, base64
payloads, GUIDs) are awkward in any tree. JotJSON marks those rows
with a small pill (and a matching `Open decoded value` entry in the
row's right-click menu); one click opens a dedicated viewer dialog
that shows the raw string with line numbers, a Copy button, and a
larger monospace font - mobile-friendly even for long payloads. When
the dialog detects a string that looks like an HTTP request or
response whose line breaks were lossily transcoded into `??`
(common in Microsoft/Azure dependent-service log payloads), it
offers an opt-in toggle to render the framing as multi-line - body
content is preserved verbatim, and a second `Copy with line breaks`
button appears so you can grab either form. The tree row itself
stays one line tall: the dialog never shifts the layout. Purely
visual; copy still gives you the literal raw string.

### Tree view that doesn't freeze on multi-MB blobs

Most online JSON tools fall over on a 5 MB document - the tree pane
hangs the browser tab and you reach for a different tool. JotJSON's
tree view is virtualized: only the rows visible in the scroll
viewport are in the DOM, so a 100,000-node blob scrolls and expands
at viewport-sized cost rather than tree-sized cost. Long values
truncate cleanly with an ellipsis and reveal the full string on
hover instead of wrapping into a multi-line row; container open /
close rows stay aligned even when a sibling has a wall-of-text
value. Search jumps and breadcrumb clicks scroll the **minimum**
amount to bring the target into view, never re-centering when the
row is already visible.

### JSONC as a first-class input

Paste configs with `//` or `/* */` comments and trailing commas - JotJSON
parses them, renders them in the tree, **and surfaces each comment inline
on the row it documents**. Trailing comments next to the value, leading
comments before it, multi-line block comments collapsed with full text in
a tooltip. Almost no other web JSON tool accepts comments at all.

### Formatting rule sets

Define named rule sets ("Error Highlighter", "API Status Codes") once and
apply them to any document. A rule has:

- **Target**: the key, the value, either side, **or both must match** (pair rule).
- **Match type**: exact / contains / starts-with / ends-with.
- **Predicates** (pair rules): `is_null`, `is_empty`, `has_content`,
  `is_number`, `is_array`, etc. - so you can say "highlight any key called
  `error` whose value is non-empty."
- **Style**: background, text color, bold/italic/underline, border accent,
  icon badge.

Apply multiple rule sets at once. Built-in presets cover errors, HTTP status
codes, null finding, and status vocabulary.

### Beacons

Any rule whose style includes an icon opts into the **Beacon UI**: matches
surface as inline icons on the row, **ancestor badges** on collapsed parent
rows ("there's an error icon hidden somewhere down here"), and **toolbar
pills** that cycle through every match in pre-order. Combined with rule
sets, it turns a 2000-line response into "click the red dot, get to the
failure."

### Manual highlights that travel with the link

Right-click any row to paint it (or its whole subtree) a literal color.
The highlights are stored on the saved blob, so when you send the link,
**the recipient sees your highlights**. No other JSON share tool lets the
author point at "look at this row" with real ink rather than just a JSON
path.

### Layered selection highlighting

Click a row and three highlights light up at once: the selected row, every
row whose value is identical (type-aware: `"1"` is not `1`), and every
ancestor up to the root - each in its own theme-aware color. The
matching-value lights are gold for finding repeated IDs, magic strings, or
duplicated config across a big document.

### Tree-editor selection sync, bidirectional

Click a tree row and the editor scrolls to and highlights the matching
token range. Move the editor cursor and the matching tree row selects,
expanding collapsed ancestors and scrolling into view. Both directions,
single toggle. Other tools don't sync, or only sync one way.

### Per-row Isolate / Collapse siblings

Right-click any row to fold the rest of the tree to focus on that branch:

- **Isolate** collapses every expanded peer at every ancestor level.
- **Collapse siblings** only collapses peers in the immediate parent.

Both leave your row's own subtree expansion intact. **Expand to depth +N
from here** does additive-only expansion underneath the row - it never
collapses anything you'd already opened.

### Auto-fit tree to your viewport

The first time a document renders, JotJSON picks an expansion depth that
fills the visible window without overflowing - a small object opens fully,
a 50,000-row monster opens collapsed at the right depth. Your manual
expand/collapse choices afterwards stick.

### Title suggestions

Hit the wand icon next to the title input. JotJSON looks at your document
and proposes 2-7 candidate titles. It recognizes `package.json`,
Kubernetes manifests, OpenAPI specs, JSON Schema, GeoJSON, ARM templates,
`tsconfig`, GitHub Actions workflows, Postman collections, and HAL
self-links, plus common identifier fields (`name`, `title`, `displayName`,
the first sentence of `description`).

### Configurable date/time annotations

When a string parses as a date, JotJSON appends `(Nov 5, 2024 - 1 year ago)`
in muted italic next to the raw value. The relative time updates live, the
formatter is per-unit configurable (turn off years, or seconds, or just
months), and you can choose friendly phrases ("yesterday") vs. always-
numeric ("in 1 day"). Plus separate toggles for whether unzoned ISO
strings are read as UTC or local.

### Install once, open `.json` from your OS

Install JotJSON as a PWA in any Chromium-based browser and your OS
registers it as a real handler for `.json`, `.jsonc`, `.json5`, and
`.webmanifest`. Double-click a JSON file in Explorer or Finder, pick
JotJSON from the right-click "Open with" menu, or run
`start data.json` (Windows) / `open -a JotJSON data.json` (macOS) /
`xdg-open data.json` (Linux desktop) from your terminal -- the file
opens in a fresh JotJSON window with the editor already loaded.
Competing online JSON tools don't register as a file handler, so
they're locked behind a browser-tab + manual-upload step every time.

---

## Plus the basics, done well

- Format / minify, with a comment-preserving formatter (`jsonc-parser`)
- Sort object keys alphabetically -- whole document from the toolbar, single object from the right-click menu
- One-click smart-paste button that lights up when the clipboard contains JSON
- Cold-boot auto-paste: opt in once and JotJSON quietly loads JSON from the
  clipboard on every fresh launch, with one-click Undo
- Drag-and-drop file upload (up to 5 MB) with binary-file rejection
- Download as `.json` / `.jsonc` (extension auto-picked from content)
- Live validation with line + column on parse errors
- Find across keys, values, or both, with case-sensitive matching and a 5-way mode picker (contains / starts-with / ends-with / exact / regex)
- Collapse all / expand all / expand to level 1-10, with keyboard shortcuts
- Selection breadcrumb with **Copy JSON path** and a configurable root prefix
  (`$`, lodash-style, `root.`, `Data.`, or none)
- Per-row context menu: copy key / value / path, find by key / value, expand-from-here
- Double-click a leaf row (or an empty `{}` / `[]`) to copy its value; double-click a non-empty container to expand or collapse it
- Press `Ctrl+C` / `Cmd+C` with a tree row focused to copy the focused row's value (works on leaves, containers, and empty containers alike)
- Inferred type badges on every row: `uuid`, `url`, `email`, `path`, `ipv4`,
  `ipv6`, `date`, plus container item / key counts
- Status bar: meaningful character count (whitespace and comments
  excluded), byte size, line count, cursor position, total node count,
  max depth, array vs. object counts
- Themes: dark / light / match-system, with per-theme color customization for
  every highlight slot
- 4-way layout: editor only, side-by-side, stacked, tree only - resizable split
- Editor / tree / find preferences (font size, tab size, word wrap, default
  expansion depth, default find scope)
- Keyboard shortcuts: `Ctrl+F` (context-aware between editor and tree),
  `Ctrl+Shift+[` / `]`, `Alt+1` .. `Alt+9`
- Keyboard-friendly app shell: a "Skip to main content" link as the first
  Tab stop on every route, primary navigation marked up as a real `<nav>`
  landmark, and screen-reader focus moves to the new page on every route
  change
- Keyboard-navigable tree view: Tab to enter, Up/Down/Home/End to move
  between rows, Right/Left to expand/collapse or jump to first child /
  parent, Enter or Space to select, Shift+F10 / ContextMenu key to open
  the row menu - with the full WAI-ARIA Tree contract (`role="treeitem"`,
  level / position / set-size / expanded state) so screen readers
  announce position and structure on every move

---

## With an account

JotJSON works fully without an account. Signing in adds:

- **Save & share** as `jotjson.com/s/abc123` - the link works for anyone you
  send it to. Up to 100 saved blobs, 1 MB per blob.
- **Fork-on-save** - open someone else's blob, save it, you get a new blob
  under your account with its own slug. The Save button labels itself
  **Save as copy** so the action is never a surprise.
- **Anonymous edit + sign-in restore** - anonymous viewers can still edit a
  shared blob locally; clicking "Sign in to save" snapshots their work,
  redirects through sign-in, and restores it on return.
- **Synced across devices** - your theme, highlight colors, active rule
  sets, default expansion depth, and path-prefix preference all roam.

## Privacy

Clipboard contents and uploaded files are read entirely client-side.
Nothing leaves your browser unless you explicitly Save & Share. Telemetry
is closed-enum counts only - never your keys, values, paths, or text.

## Install it

JotJSON is a Progressive Web App. Install it from the browser's address
bar to get a standalone window pinned to your taskbar or dock; previously
opened blobs and queued local changes drain when you come back online.

---

## Try it

[**jotjson.com**](https://jotjson.com)

Paste your worst real-world JSON and see what falls out.
