/**
 * Centralized telemetry message IDs.
 *
 * Every call to `LoggerService.info/warn/error/event` MUST use one of
 * these tokens. They are intentionally English, stable across locales,
 * and typed as a literal-union so typos fail at compile time and we
 * don't fragment telemetry across slight variants of the same id.
 * Casting (`'foo.bar' as TelemetryMessageId`) is banned in production
 * source by `scripts/check-prod-patterns.mjs`.
 *
 * Three Application Insights sinks, selected by which LoggerService
 * method you call:
 * - **`info` / `warn`** -> `trackTrace` -> `traces` table.
 *   For diagnostic / lifecycle messages aimed at humans reading logs.
 * - **`error`** -> `trackException` -> `exceptions` table.
 *   For unexpected failures with a `NormalizedError` cause.
 * - **`event`** -> `trackEvent` -> `customEvents` table.
 *   For product-analytics counters and successful-flow signals. Events
 *   support an optional `measurements` map (numeric, queryable with
 *   `percentile()` / `avg()` / `sum()`) in addition to `props`
 *   (string-keyed `customDimensions`).
 *
 * Cardinality / privacy: `customDimensions` values must be closed-enum
 * strings or pre-bucketed labels. Never log raw bytes, raw colors, raw
 * URLs, raw search query text, or any PII. Use the helpers in
 * `./buckets.ts` (`bucketBytes`, `bucketCount`) for numeric size /
 * count dimensions; pair the bucket dimension with the raw number as
 * a measurement when both are useful. Narrow exception: build-identity
 * dimensions (`version`, `sha`, `branch`, `dirty` on `app.boot`) are
 * exempt because they take at most one value per deploy across all
 * sessions; total dimension cardinality is bounded by deploy count,
 * not session count.
 *
 * Each token has a JSDoc block documenting:
 * - **Severity / kind**: `info` | `warn` | `error` | `event`. Drives
 *   the sink (see above) and, for traces, which `console.*` mirror is
 *   used.
 * - **Fired by**: the call site(s). Some tokens have multiple call
 *   sites; all are listed.
 * - **Props**: the shape attached to `LoggerService.X(token, props)`.
 *   `none` means the call passes no props.
 * - **Measurements** (events only): the numeric map shape, if any.
 * - **Exception**: error-only. The error object passed as the `cause`
 *   argument to `logger.error(token, cause, props?)`, which is
 *   normalized via `normalizeError` into `trackException` telemetry.
 *
 * When adding a new token, add a JSDoc block above it documenting
 * kind, call site, props, and (for events) measurements (see
 * `AGENTS.md` -> Logging).
 */
export const TELEMETRY_MESSAGE_IDS = [
  // Generic

  /**
   * Severity: error
   * Fired by: `TelemetryErrorHandler.handleError`
   *           (`core/telemetry/error-handler.ts`)
   * Props: none
   * Exception: any value caught by Angular's global `ErrorHandler`
   * (component lifecycle exceptions, unhandled rejections that bubble
   * to the framework, etc.).
   */
  'app.unhandled',

  /**
   * Severity: error
   * Fired by: `LoggerService.flushSessionStorage` via direct
   *           `telemetry.trackException(..., {messageId})` in
   *           `core/telemetry/logger.service.ts` (does NOT route
   *           through `logger.error`)
   * Props: none. (The `messageId` tag is attached to the
   * `trackException` envelope, not as `props`.)
   * Exception: a `{name, message}` shape reconstructed from
   * `sessionStorage` after a boot-time failure that wrote to the
   * `BOOT_FAIL_KEY` slot before the SDK was ready.
   */
   'boot.failed',

  /**
   * Kind: event
   * Fired by: lazy-import block in `AppComponent.ngOnInit`
   *           (`app/app.component.ts`) once per page load, BEFORE
   *           `LoggerService.connect()` resolves (the buffered entry
   *           is replayed once the SDK is up).
   * Props: { version: string; sha: string; branch: string; dirty: boolean }
   *   sourced from `BUILD_INFO` (`src/generated/build-info.ts`).
   *   See preamble for the build-identity carve-out.
   * Measurements: none.
   */
  'app.boot',

  // HTTP / API

  /**
   * Severity: warn
   * Fired by: `errorInterceptor` (`core/interceptors/error.interceptor.ts`)
   * Props: { method: string; pathTemplate: string; status: number }.
   * `pathTemplate` is the request URL with query / fragment stripped
   * via `sanitizePath` so we never log search terms or continuation
   * tokens.
   */
  'api.error',

  // Service worker / updates

  /**
   * Severity: warn
   * Fired by: `AppUpdateService.activateAndReload`
   *           (`core/update/app-update.service.ts`)
   * Props: none. The component falls through to a hard reload after
   * `activateUpdate()` rejects, so no further detail is captured.
   */
  'update.activate.failed',

  /**
   * Severity: warn
   * Fired by: `AppUpdateService.start` -> `swUpdate.unrecoverable`
   *           subscriber (`core/update/app-update.service.ts`)
   * Props: { reason: string }. Forwarded straight from
   * `UnrecoverableStateEvent.reason`.
   */
  'update.unrecoverable',

  /**
   * Kind: event
   * Fired by: `AppUpdateService.activateAndReload`
   *           (`core/update/app-update.service.ts`) AFTER
   *           `swUpdate.activateUpdate()` resolves and BEFORE
   *           `reload()`. `TelemetryService.flush()` is awaited
   *           between the event and the reload so the envelope
   *           dispatches before the navigation tears down the
   *           document.
   * Props: none.
   * Measurements: none.
   */
  'update.applied',

  // Editor

  /**
   * Severity: error
   * Fired by: `JsonEditorComponent.ngAfterViewInit`
   *           (`shared/components/json-editor/json-editor.component.ts`)
   * Props: none
   * Exception: any error from the lazy-loaded `loadMonaco()` import
   * (chunk load failure, network error, etc.).
   */
  'monaco.loadFailed',

  /**
   * Kind: event
   * Fired by: `JsonEditorComponent.ngAfterViewInit` after the FIRST
   *           successful `loadMonaco()` resolution per page load
   *           (`shared/components/json-editor/json-editor.component.ts`).
   *           Subsequent component remounts that hit the cached
   *           `window.monaco` do NOT emit -- this token measures the
   *           one-time Monaco distribution download / initialization,
   *           not editor mount counts.
   * Props: none.
   * Measurements: { loadTimeMs: number }. Wall-clock time from the
   *   `await loadMonaco()` call entering until it resolves.
   */
  'monaco.loaded',

  // Home / share

  /**
   * Severity: warn
   * Fired by: `HomeComponent.onSave`
   *           (`features/home/home.component.ts`)
   * Props: none. The component sets `saveError` for the user; this
   * log is purely a counter.
   */
  'home.save.failed',

  /**
   * Severity: warn
   * Fired by: `HomeComponent.onFilesReceived` (`tooLarge` branch)
   *           (`features/home/home.component.ts`)
   * Props: { sizeBytes: number }. The actual file size in bytes
   * (always > `MAX_UPLOAD_BYTES`); useful for analyzing how far over
   * the limit users land.
   */
  'home.upload.tooLarge',

  /**
   * Severity: warn
   * Fired by: `HomeComponent.onFilesReceived` (`readFailed` branch)
   *           (`features/home/home.component.ts`)
   * Props: { cause: string }. `String(result.cause)` of the underlying
   * `arrayBuffer()` rejection - we do not log the filename to keep
   * file metadata out of telemetry.
   */
  'home.upload.readFailed',

  /**
   * Severity: info
   * Fired by: `HomeComponent.onFilesReceived` (`binary` branch)
   *           (`features/home/home.component.ts`)
   * Props: { filename: string }. Filename is logged here (and only
   * here) because rejecting a binary upload is an actionable signal
   * for the user; the filename helps a developer reproduce.
   */
  'home.upload.binary',

  /**
   * Kind: event
   * Fired by: `HomeComponent.onPaste`
   *           (`features/home/home.component.ts`) on every successful
   *           toolbar-driven paste. The early-return on empty /
   *           whitespace clipboard does NOT emit.
   *           `HomeComponent.onEditorPaste` (native Monaco paste,
   *           no clipboard read) is a separate code path and does
   *           NOT emit this token.
   * Props: { sizeBytesBucket: SizeBucket } via `bucketBytes` over
   *   the UTF-8 byte count of the clipboard text.
   * Measurements: { sizeBytes: number; clipboardReadMs: number;
   *   parseMs: number; syncHandlerMs: number; firstPaintMs: number }.
   *   - `clipboardReadMs`: time awaiting `clipboard.readForPaste()`.
   *   - `parseMs`: synchronous time inside `parser.tryUnescape`.
   *   - `syncHandlerMs`: T0 to end-of-synchronous-handler. Includes
   *     `clipboardReadMs`.
   *   - `firstPaintMs`: T0 to first painted frame after the content
   *     signal write, via double `requestAnimationFrame`. The
   *     user-perceived end-to-end latency.
   *   Reactive tree build/render in `JsonTreeComponent` is NOT
   *   separately captured here; it is folded into the gap between
   *   `syncHandlerMs` and `firstPaintMs`.
   */
  'paste.handle',

  /**
   * Kind: event
   * Fired by: `HomeComponent.onFilesReceived` 'ok' branch
   *           (`features/home/home.component.ts`). Failure branches
   *           (`tooLarge`, `binary`, `readFailed`) keep their
   *           existing warn tokens; this event counts only
   *           successful uploads.
   * Props: { sizeBytesBucket: SizeBucket; source: 'drag' | 'pick' }.
   *   `'drag'` = files via the document drag-drop controller;
   *   `'pick'` = the toolbar Upload button (`<input type="file">`).
   * Measurements: { sizeBytes: number; fileReadMs: number;
   *   parseMs: number; syncHandlerMs: number; firstPaintMs: number }.
   *   See `paste.handle` for `parseMs` / `syncHandlerMs` /
   *   `firstPaintMs` semantics. `fileReadMs` is the time spent in
   *   `validateAndReadSingleFile` (file I/O including text decode).
   */
  'upload.handle',

  /**
   * Severity: warn
   * Fired by: `HomeComponent.onToggleVisibility`
   *           (`features/home/home.component.ts`)
   * Props: none
   */
  'share.visibility.failed',

  /**
   * Kind: event
   * Fired by: `HomeComponent.onSave`
   *           (`features/home/home.component.ts`) after a successful
   *           `BlobService.create` (create branch only -- the
   *           update branch has no creation semantic).
   * Props: { visibility: 'public' | 'private' }. Today always
   *   `'private'` (create passes `isPublic=false`); the dimension
   *   shape is locked now so a future public-create flow can reuse
   *   the token without renaming.
   * Measurements: { sizeBytes: number }. UTF-8 byte count of the
   *   saved content.
   */
  'share.created',

  /**
   * Kind: event
   * Fired by: `HomeComponent.onToggleVisibility`
   *           (`features/home/home.component.ts`) after a successful
   *           `BlobService.update({ isPublic })`. Failures keep the
   *           existing `share.visibility.failed` warn token.
   * Props: { newVisibility: 'public' | 'private' }. The new value;
   *   `oldVisibility` is the opposite by definition of a toggle and
   *   is not separately logged.
   * Measurements: none.
   */
  'share.visibility.changed',

  /**
   * Severity: warn
   * Fired by: `HomeComponent.onDeleteBlob`
   *           (`features/home/home.component.ts`),
   *           `BlobsComponent.deleteBlob`
   *           (`features/blobs/blobs.component.ts`)
   * Props: none. Both call sites toast the same user-facing error;
   * the shared token lets us count failures across entry points.
   */
  'share.delete.failed',

  // Blobs

  /**
   * Severity: warn
   * Fired by: `BlobsComponent.load`
   *           (`features/blobs/blobs.component.ts`)
   * Props: none. The component sets an error message in the UI; this
   * is purely a counter.
   */
  'blobs.load.failed',

  /**
   * Severity: warn
   * Fired by: `BlobsComponent.copyLink`
   *           (`features/blobs/blobs.component.ts`)
   * Props: none. Fired when the clipboard write returns false (user
   * already toasted via `clipboardCopy.copyWithToast`).
   */
  'blobs.copyLink.failed',

  // History

  /**
   * Severity: warn
   * Fired by: `HistoryComponent.reload`
   *           (`features/history/history.component.ts`)
   * Props: none
   */
  'history.load.failed',

  /**
   * Severity: warn
   * Fired by: `HistoryComponent.loadMore`
   *           (`features/history/history.component.ts`)
   * Props: none
   */
  'history.loadMore.failed',

  /**
   * Severity: warn
   * Fired by: `HistoryComponent.clearHistory`
   *           (`features/history/history.component.ts`)
   * Props: none
   */
  'history.clear.failed',

  /**
   * Kind: event
   * Fired by: `HistoryComponent.openEntry`
   *           (`features/history/history.component.ts`) after
   *           `router.navigate(['/s', slug])` resolves with `true`.
   *           Entries with no `slug` (deleted blobs) early-return
   *           and do NOT emit. A navigation that resolves with
   *           `false` (guard rejection, etc.) also does not emit.
   * Props: none. Slug, title, and entry content are intentionally
   *   not logged.
   * Measurements: none.
   */
  'history.entry.restored',

  // Auth

  /**
   * Severity: error
   * Fired by: `LoggerService` constructor via
   *           `msalBridge.attachConsumer` consumer
   *           (`core/telemetry/logger.service.ts`); upstream emitter
   *           is the MSAL `loggerCallback` in
   *           `core/auth/msal-instance.ts`, which calls
   *           `msalBridge.publish(message)` for `LogLevel.Error`
   *           messages without PII.
   * Props: { message: string; aadCode: string | undefined }. `message`
   * is PII-redacted via `redactPii` before publish; `aadCode` is the
   * extracted `AADSTSnnnnn` code if present.
   * Exception: none (the `cause` arg is `null`; this is a trace-style
   * error sent to `trackException` for visibility).
   */
  'msal.error',

  /**
   * Severity: warn
   * Fired by: `AuthService` constructor
   *           (`core/auth/auth.service.ts`)
   * Props: { reason: string }. Currently always
   * `'userId-format'` - emitted when `environment.devAuth.enabled` is
   * true but `userId` fails the `^[a-z0-9_-]{1,64}$` regex, which
   * fail-closes the dev-auth bypass.
   */
  'auth.devMode.misconfigured',

  /**
   * Kind: event
   * Fired by: `AuthService.setCurrentUser` on every null -> user
   *           transition (`core/auth/auth.service.ts`). Covers BOTH
   *           explicit sign-in flows (which complete via
   *           redirect-back -> `handleRedirectPromise` ->
   *           `refreshFromCache` -> `setCurrentUser`) AND
   *           cached-session resumes on a fresh page load.
   *           Interpret as "authenticated session observed", not
   *           "user just clicked sign-in":
   *           `customEvents | where name == 'auth.signedIn' |
   *           summarize dcount(user_AuthenticatedId)
   *           by bin(timestamp, 1d)` for DAU. A separate token would
   *           be needed for fresh-click funnel analytics.
   * Props: { mode: 'dev' | 'msal' }. Distinguishes the
   *   `environment.devAuth` short-circuit path from real MSAL.
   * Measurements: none.
   */
  'auth.signedIn',

  /**
   * Kind: event
   * Fired by: `AuthService.signOut` directly, BEFORE
   *           `logoutRedirect` (real MSAL) or `setCurrentUser(null)`
   *           (dev mode), with `TelemetryService.flush()` awaited
   *           between event emission and the redirect so the
   *           envelope dispatches before MSAL tears down the
   *           document. Emitting from the null-transition in
   *           `setCurrentUser` is unreliable for real MSAL because
   *           the LOGOUT_SUCCESS broadcast races the redirect.
   * Props: { mode: 'dev' | 'msal' }.
   * Measurements: none.
   */
  'auth.signedOut',

  // Toolbar / actions

  /**
   * Kind: event
   * Fired by: `ToolbarComponent` handlers
   *           (`shared/components/toolbar/toolbar.component.ts`)
   *           BEFORE the existing `EventEmitter.emit()` so the
   *           gesture is captured even if a parent handler later
   *           throws. Action is a closed-enum:
   *
   *   `paste`         -- Paste button click.
   *   `copy`          -- Copy button (no modifier).
   *   `copyEscaped`   -- Copy button with Alt held (issue #38
   *                      power-user JSON-string-literal variant).
   *   `openFile`      -- Upload button click that triggers the
   *                      hidden file picker.
   *   `download`      -- Download button click.
   *   `format`        -- Format / pretty-print button.
   *   `minify`        -- Minify button.
   *   `clear`         -- Clear button.
   *   `save`          -- Save button (or Enter on title field).
   *   `copyShareLink` -- overflow menu "Copy share link".
   *   `togglePublic`  -- overflow menu "Make public/private".
   *                      The resulting visibility flip is logged
   *                      separately as `share.visibility.changed`.
   *   `deleteBlob`    -- overflow menu "Delete".
   *   `fileChange`    -- a file was actually selected from the
   *                      picker (post-`openFile`, gives funnel
   *                      completion).
   *
   * NOT in this enum: mode toggle (json/jsonc), theme toggle,
   * selection-sync toggle, pane-layout segmented control. Those
   * mutate preferences and surface via `pref.changed` instead.
   *
   * Props: { action: <closed-enum above> }.
   * Measurements: none.
   */
  'toolbar.action',

  // Profile / preferences

  /**
   * Kind: event
   * Fired by: `PreferencesService.applyPrefs`
   *           (`core/preferences/preferences.service.ts`) once per
   *           changed key per call. This is an internal chokepoint
   *           that catches ALL mutation paths: public `update(patch)`,
   *           public `reset()`, sign-in hydration / sign-out reset
   *           in `handleAuthTransition`, and (future) server-pushed
   *           sync. The constructor's initial-load from
   *           `localStorage` and the system-theme matchMedia
   *           recompute are NOT routed through here -- they
   *           produce no observable diff for analytics.
   *
   * Per-key emission policy: a `pref.changed` event fires only when
   * the deep-equal-compared value for the key actually changes.
   * For nested objects (`treeHighlightColors`) the event fans out
   * to one event per leaf color slot, with a dotted key name like
   * `treeHighlightColors.dark.selectionColor`.
   *
   * Props (always): { key: PrefKey; source: 'user' | 'init' | 'sync';
   *   kind: 'string' | 'boolean' | 'number' | 'count' | 'color' }.
   *   `key` is a closed enum derived from the `UserPreferences`
   *   schema (and dotted leaf paths for `treeHighlightColors`);
   *   total cardinality is bounded by the schema, not by users.
   *
   * Props by kind (one of):
   *   kind = 'string'  : { value: <closed-enum from schema> } e.g.
   *                      theme, layoutOrientation, searchScope,
   *                      searchValueType, blobQuotaStrategy,
   *                      treePathRoot.
   *   kind = 'boolean' : { value: 'true' | 'false' }.
   *   kind = 'number'  : { valueBucket: <bounded bucket string> };
   *                      measurement { value: number }.
   *   kind = 'count'   : { countBucket: CountBucket };
   *                      measurement { count: number }. Used for
   *                      `defaultRuleSetIds`.
   *   kind = 'color'   : { isDefault: 'true' | 'false';
   *                        bucket: ColorBucket }.
   *                      ColorBucket = 'red' | 'orange' | 'yellow'
   *                        | 'green' | 'teal' | 'blue' | 'purple'
   *                        | 'pink' | 'gray' | 'custom'. Raw hex
   *                      is NEVER logged -- only the coarse named
   *                      bucket plus a default-flag.
   */
  'pref.changed',

  // Formatting rule sets (M6g-1)

  /**
   * Severity: info
   * Fired by: `RuleSetsService.create` (manual create) and
   *           `RuleSetsService.clonePreset` (preset clone), both in
   *           `core/api/rule-sets.service.ts`
   * Props: { ruleCount: number; source: 'manual' | 'preset' }.
   * `source` distinguishes a hand-authored new set from a preset
   * clone.
   */
  'ruleSets.created',

  /**
   * Severity: info
   * Fired by: `RuleSetsService.update` (live PUT success) and the
   *           drain branch in `RuleSetsService` (queued offline write
   *           later flushed), both in `core/api/rule-sets.service.ts`
   * Props: { ruleCount: number }.
   */
  'ruleSets.updated',

  /**
   * Severity: info
   * Fired by: `RuleSetsService.delete` (live DELETE success) and the
   *           drain branch in `RuleSetsService` (queued offline
   *           delete later flushed), both in
   *           `core/api/rule-sets.service.ts`
   * Props: none
   */
  'ruleSets.deleted',

  /**
   * Severity: info
   * Fired by: `RuleSetsService` constructor effect on
   *           `defaultRuleSetIds` (`core/api/rule-sets.service.ts`).
   *           Skips the first run after hydration so steady-state
   *           startup doesn't emit a spurious event.
   * Props: { activeCount: number }. Cardinality of active rule sets
   * after the change.
   */
  'ruleSets.applied',

  // Tree row context menu (M7q)

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.openContextMenu` (right-click /
   *           breadcrumb) and `onKebabClick` (kebab button), both
   *           in `shared/components/json-tree/json-tree.component.ts`
   * Props: { source: 'row' | 'breadcrumb' | 'kebab' }.
   */
  'tree.contextMenu.opened',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.copyKey`
   *           (`shared/components/json-tree/json-tree.component.ts`)
   * Props: none
   */
  'tree.contextMenu.copyKey',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.copyValue` (`source === 'menu'`
   *           branch) (`shared/components/json-tree/json-tree.component.ts`).
   *           See also `tree.row.doubleClickCopyValue` for the
   *           `'dblclick'` branch.
   * Props: none
   */
  'tree.contextMenu.copyValue',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.copyPathFromMenu`
   *           (`shared/components/json-tree/json-tree.component.ts`)
   * Props: none. See also `tree.breadcrumb.copyPath` for the
   * breadcrumb-bar entry point.
   */
  'tree.contextMenu.copyPath',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.searchByKey`
   *           (`shared/components/json-tree/json-tree.component.ts`)
   * Props: none
   */
  'tree.contextMenu.searchByKey',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.searchByValue`
   *           (`shared/components/json-tree/json-tree.component.ts`)
   * Props: none
   */
  'tree.contextMenu.searchByValue',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.collapseFromHere`
   *           (`shared/components/json-tree/json-tree.component.ts`)
   * Props: none
   */
  'tree.contextMenu.collapse',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.expandAllFromHere`
   *           (`shared/components/json-tree/json-tree.component.ts`)
   * Props: none
   */
  'tree.contextMenu.expandAllFromHere',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.expandToDepthFromHere`
   *           (`shared/components/json-tree/json-tree.component.ts`)
   * Props: { relativeDepth: number }. The N in "expand N levels from
   * here"; lets us see which depths users invoke most often.
   */
  'tree.contextMenu.expandToDepth',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.isolate` (`source === 'narrow'`
   *           branch with no wider set, OR explicit narrow-isolate
   *           call from the menu)
   *           (`shared/components/json-tree/json-tree.component.ts`).
   *           Used as the single "Isolate" token when the wide and
   *           narrow flavors would behave identically; otherwise
   *           split out as `isolateNarrow` / `isolateWide`.
   * Props: none
   */
  'tree.contextMenu.isolate',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.collapseSiblings`
   *           (`shared/components/json-tree/json-tree.component.ts`)
   * Props: none. Narrow isolate: collapses only off-chain siblings
   * under the immediate parent.
   */
  'tree.contextMenu.isolateNarrow',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.isolate` (`source === 'wide'`
   *           branch)
   *           (`shared/components/json-tree/json-tree.component.ts`)
   * Props: none. Wide isolate: collapses every off-chain sibling at
   * every higher ancestor as well as immediate-parent peers.
   */
  'tree.contextMenu.isolateWide',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.copyValue` (`source === 'dblclick'`
   *           branch) (`shared/components/json-tree/json-tree.component.ts`).
   *           See also `tree.contextMenu.copyValue` for the
   *           menu-driven entry point; both share copy semantics.
   * Props: none
   */
  'tree.row.doubleClickCopyValue',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.onBreadcrumbClick`
   *           (`shared/components/json-tree/json-tree.component.ts`)
   * Props: { depth: number; selectionUpDistance: number }. `depth`
   * is the clicked chip's depth from the root; `selectionUpDistance`
   * is how many levels up from the prior selection it was (0 when
   * the current chip is re-clicked). Path content is intentionally
   * NOT recorded (potentially user-sensitive).
   */
  'tree.breadcrumb.click',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.onBreadcrumbCopyPath`
   *           (`shared/components/json-tree/json-tree.component.ts`)
   * Props: { depth: number; selectionUpDistance: number }.
   * `selectionUpDistance` is always `0` here (we copy the path of
   * the current selection, not navigate elsewhere); kept for shape
   * parity with `tree.breadcrumb.click`.
   */
  'tree.breadcrumb.copyPath'
] as const;

export type TelemetryMessageId = (typeof TELEMETRY_MESSAGE_IDS)[number];
