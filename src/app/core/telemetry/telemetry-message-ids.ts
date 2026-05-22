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
 * dimensions (`version`, `sha`, `branch`, `buildNumber` on `app.boot`
 * and `sw.*`) are exempt because they take at most one value per
 * deploy across all sessions; total dimension cardinality is bounded
 * by deploy count, not session count.
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
   * Kind: event
   * Fired by: `TelemetryErrorHandler.handleError`
   *           (`core/telemetry/error-handler.ts`) when the noise
   *           classifier in `core/telemetry/noise-filter.ts` returns
   *           `'suppress'`. Suppressed errors do NOT also flow to
   *           `'app.unhandled'` -- this counter is the only signal
   *           they emit so we can monitor cancellation volume in
   *           `customEvents` without polluting the `exceptions` table.
   * Props: { reasonBucket: 'monacoCanceled' }.
   *   `monacoCanceled`: Monaco's `CancellationError` thrown during
   *   normal editor / completion-provider disposal.
   *   The bucket is a closed enum; expand here when a new suppress
   *   rule is added to `noise-filter.ts`.
   * Measurements: none.
   * Bounded-frequency: bounded by Monaco editor lifecycle events
   *   (mount / dispose / completion-provider teardown). Can be high
   *   during chatty editor sessions but not unbounded.
   * Console mirror: SUPPRESSED. This ID is in `QUIET_CONSOLE_IDS`
   *   (`core/telemetry/logger.service.ts`) so the per-cancellation
   *   `console.info` line is dropped; App Insights dispatch is
   *   unaffected. The whole point of this counter is to filter
   *   noise out of dev DevTools while keeping it queryable in
   *   `customEvents`.
   */
  'errorHandler.suppressed',

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
   * Props: {
   *   version: string;
   *   sha: string;
   *   branch: string;
   *   buildNumber: string;
   *   envLabel: 'prod' | 'nonprod' | 'preview' | 'dev' | 'unknown';
   *   previewHasPrNumber?: 'true' | 'false';
   * }
   *   `version`, `sha`, `branch`, `buildNumber` sourced from
   *   `BUILD_INFO` (`src/generated/build-info.ts`). `buildNumber` is
   *   `git rev-list --count HEAD` from the build that produced the
   *   artifact, or the sentinel `'unknown'` if the checkout was
   *   shallow / git was unavailable. See preamble for the build-
   *   identity carve-out.
   *   `envLabel` is the runtime environment classification from
   *   `EnvLabelService` (see `core/env/env-label.ts`). A closed enum
   *   of five values; answers "how often do real users hit the
   *   nonprod URL?" and "are we ever misclassifying prod as
   *   'unknown'?". Always 'prod' on server-platform (prerender).
   *   `previewHasPrNumber` is emitted ONLY when `envLabel ===
   *   'preview'` (the prop is omitted from the envelope otherwise).
   *   Closed-enum `'true' | 'false'` indicates whether
   *   `EnvLabelService` could extract a PR number from the SWA
   *   preview hostname slug. Answers "did the regex-vs-cd-preview.yml
   *   slug contract drift?" -- a sudden spike of `'false'` on preview
   *   means Azure or `.github/workflows/cd-preview.yml` changed the
   *   URL slug shape and the per-PR title indicator silently
   *   regressed to plain `[preview]`. Low-cardinality (two values);
   *   bounded-frequency (one event per session).
   * Measurements: none.
   */
  'app.boot',

  /**
   * Kind: event
   * Fired by: `initWebVitals` in
   *           `core/telemetry/web-vitals.ts`, lazily loaded from
   *           `AppComponent.ngOnInit`. The `web-vitals` npm package
   *           is dynamic-imported as its own chunk so it stays out
   *           of the initial bundle.
   *
   * Subscribes to `onLCP` / `onINP` / `onCLS` and accumulates the
   * latest reported value for each metric. On the first `pagehide`
   * event of the page lifecycle (registered with `{ once: true }`),
   * emits ONE `webVitals` event with whatever metrics have
   * finalized. If none have, the event is suppressed -- an
   * empty event is noise.
   *
   * Hand-rolled `PerformanceObserver` was rejected at planning
   * time because BFCache resume, INP attribution, and CLS-window
   * close-on-hidden semantics are subtle; the package gets them
   * right.
   *
   * Props: { appVersion: string; buildNumber: string }
   *   `appVersion` sourced from `BUILD_INFO.version`; `buildNumber`
   *   from `BUILD_INFO.buildNumber` (the `git rev-list --count HEAD`
   *   counter, or `'unknown'` for shallow / dev builds).
   *   Like `app.boot`, both dimensions are exempt from the
   *   closed-enum cardinality rule (one value per deploy across
   *   sessions; see preamble carve-out).
   * Measurements: { lcpMs?: number; inpMs?: number; cls?: number }.
   *   - `lcpMs` -- Largest Contentful Paint, milliseconds.
   *   - `inpMs` -- Interaction to Next Paint, milliseconds.
   *   - `cls`   -- Cumulative Layout Shift, unitless score.
   *   Each key is omitted when the corresponding callback never
   *   fired (e.g., user closed the tab before LCP finalized).
   */
  'webVitals',

  // Performance (slow-event thresholds, A4)

  /**
   * Kind: event
   * Fired by: `JsonParserService.parse` in `core/json/json-parser.service.ts`.
   * Emitted only when wallclock parse time exceeds 50 ms; faster
   * parses are silent. Threshold-only keeps `customEvents` volume
   * bounded -- the typical case is sub-millisecond. Strict `>`:
   * `timeMs > 50` emits, `timeMs == 50` does not.
   *
   * Note: `parse()` is also called by the JSON extractor scanner and
   * incidental editor flows (`json-extractor.service.ts`,
   * `json-editor.component.ts`), not just the main document parse;
   * a `cold` first-of-session emit may originate from any caller.
   *
   * Props:
   *   { cold: boolean;
   *     sizeBytesBucket: SizeBucket }
   *   - `cold` is true on the first `parse.slow` emission per session
   *     (across all callers); false thereafter. Default KQL queries
   *     should `where cold == false` to filter cold-start noise.
   *   - `sizeBytesBucket` from `bucketBytes(sizeBytes)`.
   * Measurements: { timeMs: number; sizeBytes: number }.
   *   `sizeBytes` is the UTF-8 byte length of the parsed text
   *   (`new Blob([text]).size`), matching the existing convention
   *   in `home/status-bar/stats.ts`.
   */
  'parse.slow',

  /**
   * Kind: event
   * Fired by: `JsonTreeComponent` in
   *           `shared/components/json-tree/json-tree.component.ts`,
   *           wrapping the `root` computed signal's `buildChildren`
   *           recursion.
   * Emitted only when wallclock build time exceeds 100 ms.
   * Strict `>`: `timeMs > 100` emits.
   *
   * Props:
   *   { cold: boolean;
   *     nodeCountBucket: CountBucket }
   *   - `cold` is true on the first `tree.build.slow` per session.
   *   - `nodeCountBucket` from `bucketCount(nodeCount)`.
   * Measurements: { timeMs: number; nodeCount: number }.
   *   `nodeCount` is incremented during the same traversal that
   *   builds children; no second pass.
   */
  'tree.build.slow',

  /**
   * Kind: event
   * Fired by: `JsonTreeComponent`, via an effect keyed on
   *           the `value()` input signal that records
   *           `performance.now()` at the start and emits after a
   *           double-`requestAnimationFrame` window.
   *
   * What this measures: from "value() input changed" to "browser
   * has committed two animation frames after Angular settled". This
   * is NOT pure DOM render time -- it includes tree build,
   * datasource update, default expansion, layout, and paint. Treat
   * it as user-perceived initial render latency.
   *
   * Stale-run cancellation: a generation counter is captured at
   * effect entry and re-checked at the inner rAF; if `value()` has
   * thrashed in the meantime, the older measurement is dropped
   * silently to avoid double-emitting for transient inputs.
   *
   * Emitted only when wallclock exceeds 30 ms. Strict `>`:
   * `timeMs > 30` emits. Skipped entirely when `value()` is
   * undefined (empty tree).
   *
   * Threshold note: Phase 2 (issue #95) virtualization rewrote the
   * render path to be O(viewport) rather than O(visibleNodes), so
   * the 200 ms threshold inherited from `<mat-tree>` is no longer
   * meaningful. The 30 ms value is a placeholder until Phase 3
   * measures a fresh post-virtualization P95 on `wide-aoo @ 100K`
   * and anchors the threshold at 2 * P95.
   *
   * Props:
   *   { cold: boolean;
   *     nodeCountBucket: CountBucket }
   * Measurements: { timeMs: number; nodeCount: number }.
   */
  'tree.render.slow',

  /**
   * Kind: event
   * Fired by: `JsonTreeComponent` bulk-expand methods:
   *           `expandAll`, `expandToLevel`, `expandAllFromHere`,
   *           `expandToDepthFromHere`. Each call wraps a wallclock
   *           measurement around its expand traversal.
   *
   * Out of scope for A4: per-node chevron toggles via
   * `matTreeNodeToggle` (no jotjson handler in between -- would
   * require a wrapper directive). The constructor's initial
   * `expandToLevel(defaultTreeExpansionDepth)` is also excluded
   * (controlled by the `hasInitializedExpansion` flag) so first
   * paint isn't double-counted with `tree.render.slow`.
   *
   * Emitted only when wallclock exceeds 10 ms. Strict `>`:
   * `timeMs > 10` emits.
   *
   * Threshold note: Phase 2 (issue #95) virtualization made bulk
   * expand a Set-mutation cost (one `setExpandedBulk` write) rather
   * than a DOM-render-of-every-node cost, so the prior 50 ms threshold
   * is no longer meaningful. The 10 ms value is a placeholder until
   * Phase 3 measures a fresh post-virtualization P95 on
   * `wide-aoo @ 100K expand-all` and anchors the threshold at 2 * P95.
   *
   * Props:
   *   { cold: boolean }
   *   - `cold` is true on the first `tree.expand.slow` per session.
   * Measurements:
   *   { timeMs: number; depth: number; nodeCount: number }
   *   - `depth` is the maximum depth navigated by the action
   *     (relative to the action's start node).
   *   - `nodeCount` is the number of containers expanded by the
   *     action (counted during the same traversal).
   */
  'tree.expand.slow',

  /**
   * Kind: event
   * Fired by: `JsonTreeComponent`'s initial-expansion auto-fit
   *           branch. Runs exactly once per `root()` change when the
   *           `treeAutoFitToWindow` preference is on, the probe row
   *           height measures >= 8 px, and the resolved scroll
   *           viewport has positive `clientHeight`.
   *
   * What this measures: the chosen initial expansion depth `K`
   *   plus before-and-after fit metrics. The "estimated" measurements
   *   come from a fixed probe row height (a lower bound), and the
   *   "actual" measurements are read after expansion has been
   *   applied and the browser has committed one more animation
   *   frame.
   *
   * Stale-run cancellation: a per-auto-fit generation counter is
   *   captured at function entry and re-checked inside the post-
   *   expand rAF; if `value()` has thrashed in the meantime, the
   *   stale measurement is dropped silently.
   *
   * Cold flag: NOT applied. The event fires on every value-driven
   *   auto-fit (typically several per minute for an active editing
   *   session); we want each run sampled, not just the first per
   *   session. Volume is acceptable -- frontend telemetry is
   *   unsampled by design and the per-user emit rate is moderate.
   *
   * Props: none. Closed-enum constraints don't apply because the
   *   event carries no string dimensions.
   * Measurements:
   *   { chosenDepth: number;
   *     totalNodes: number;
   *     viewportPx: number;
   *     probeRowPx: number;
   *     estimatedRows: number;
   *     chosenRows: number;
   *     fillRatioPct: number;
   *     actualHeightPx: number;
   *     actualFillRatioPct: number }
   *   - `chosenDepth`: the picked K (root = 0).
   *   - `totalNodes`: total nodes in the tree (all depths).
   *   - `viewportPx`: scroll-container clientHeight at compute time.
   *   - `probeRowPx`: measured probe row height (lower bound).
   *   - `estimatedRows`: floor(viewportPx / probeRowPx).
   *   - `chosenRows`: sum(nodesAt[0..chosenDepth]).
   *   - `fillRatioPct`: round(chosenRows / estimatedRows * 100).
   *   - `actualHeightPx`: post-expand `scrollHeight` of the scroll
   *     container, measured one rAF after `expandToLevel(K)`.
   *   - `actualFillRatioPct`: round(actualHeightPx / viewportPx
   *     * 100). Use this to tune the 1.5x overflow tolerance.
   */
  'tree.expand.autoFit',

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
  //
  // The seven `update.*` tokens below are FROZEN FOR HISTORY. The
  // `AppUpdateService` (and the `@angular/service-worker` dependency
  // it wrapped) were removed when ngsw was replaced with a minimal
  // pass-through service worker (see plan.md - SW migration). The
  // tokens stay in this literal-union so KQL queries that joined on
  // them across the cutover still parse, but they have no emit sites
  // in production code. The `scripts/check-deprecated-telemetry.mjs`
  // lint gate fails CI if any production code re-emits them. The
  // post-migration replacements live below under "Service worker
  // (post-migration)".

  /**
   * Severity: event
   * Fired by: `AppUpdateService.onVersionReady`
   *           (`core/update/app-update.service.ts`) immediately after
   *           choosing the silent-apply vs snackbar branch for a
   *           `VERSION_READY` service-worker event.
   * Props: { userInteracted: 'true' | 'false';
   *   guardClaimed: 'true' | 'false';
   *   pathTaken: 'silentApply' | 'snackbar';
   *   fromSha: string; toSha: string }.
   *   `fromSha` and `toSha` come from Angular SW `appData.buildSha`;
   *   empty string is used when older manifests lack `appData`. Build
   *   SHA dimensions use the build-metadata cardinality carve-out in
   *   the preamble / AGENTS.md telemetry rules.
   * Measurements: { msSinceBoot: number }. Raw `performance.now()`
   *   elapsed time when the branch decision is made.
   * Bounded-frequency: one per detected new version (typically one per
   *   active-user session).
   */
  'update.versionReady',

  /**
   * Severity: event
   * Fired by: `AppUpdateService.maybeCheck`
   *           (`core/update/app-update.service.ts`) after
   *           `swUpdate.checkForUpdate()` resolves or rejects, or when
   *           the check short-circuits because the service worker is not
   *           ready.
   * Props: { reason: 'init' | 'visibility' | 'focus';
   *   result: 'noChange' | 'newVersion' | 'error' | 'swNotReady' }.
   * Measurements: { durationMs: number }. Raw wall-clock duration from
   *   check start to settle / short-circuit.
   * Bounded-frequency: at most one per 30s rate-limited check plus
   *   visibility / focus events that pass the rate limit.
   */
  'update.check.result',

  /**
   * Severity: event
   * Fired by: `AppUpdateService`'s `swUpdate.unrecoverable` subscriber
   *           (`core/update/app-update.service.ts`) immediately before
   *           `hardReload()`.
   * Props: { reasonBucket: 'hashMismatch' | 'fetchFailed' | 'other' }.
   *   The bucket is switch-mapped from Angular SW's free-form
   *   `UnrecoverableStateEvent.reason`; the existing
   *   `update.unrecoverable` warn token preserves the raw diagnostic
   *   reason in traces.
   * Measurements: none.
   * Bounded-frequency: at most once per session because `hardReload()`
   *   immediately follows and ends the current page lifecycle.
   */
  'update.unrecoverable.event',

  /**
   * Severity: event
   * Fired by: `AppUpdateService` constructor
   *           (`core/update/app-update.service.ts`) once on the browser
   *           platform when the eager root service is created.
   * Props: { swEnabled: 'true' | 'false';
   *   swHasController: 'true' | 'false' }.
   * Measurements: none.
   * Bounded-frequency: exactly one per service init.
   */
  'update.swState',

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
   * Props:
   *   - `trigger`: closed-enum `'snackbar' | 'autoApply'`. Distinguishes
   *     a user-clicked Reload on the version-available snackbar from a
   *     cold-launch silent auto-apply (no user interaction yet, no
   *     prior silent-apply this session). The two paths converge in
   *     `activateAndReload()`; the trigger argument is propagated from
   *     the caller.
   * Measurements: none.
   */
  'update.applied',

  // Service worker (post-migration)

  /**
   * Severity: event
   * Fired by: `registerServiceWorker`
   *           (`core/telemetry/sw-registration.ts`), invoked from
   *           the pre-bootstrap block in `src/main.ts`. Queued to
   *           `sessionStorage` (key `jotjson.sw.events`) until
   *           `LoggerService.flushSwEvents()` drains the queue on
   *           first SDK connect; subsequent calls emit directly via
   *           `attachSwEventDirectEmit`.
   * Props: { version: string; sha: string; branch: string;
   *   buildNumber: string }. Build identity is captured at queue
   *   time from `BUILD_INFO` and passed through the drain as
   *   `props`; `LoggerService` does NOT auto-attach build identity
   *   (only `privacyInitializer` is registered with the SDK), so
   *   every `sw.*` token must carry the dimensions explicitly per
   *   the build-identity carve-out in the preamble.
   * Measurements: none.
   * Bounded-frequency: one per page load.
   */
  'sw.registered',

  /**
   * Severity: event
   * Fired by: `reportActivatedOnce` closure inside
   *           `registerServiceWorker` (`core/telemetry/
   *           sw-registration.ts`). Guarded by a per-page-load
   *           closure boolean so it fires at most once even when
   *           both `reg.active.state === 'activated'` and a later
   *           `statechange` to `'activated'` would otherwise both
   *           dispatch. The closure guard resets on `updatefound`
   *           so a second activation within the same page load
   *           (e.g. forced `reg.update()` returning new bytes)
   *           re-fires. Also filtered by
   *           `sw.scriptURL.endsWith('/sw.js')` so the legacy-
   *           alias worker briefly being `reg.active` mid-migration
   *           does NOT count.
   *
   * THE canonical "migration succeeded" signal. KQL queries
   *   discriminate the pre-/post-migration eras via
   *   `customDimensions.buildNumber` (see `docs/telemetry.md` and
   *   `docs/sw-migration.md`).
   * Props: { version: string; sha: string; branch: string;
   *   buildNumber: string }. Explicitly carried in payload per the
   *   build-identity carve-out in the preamble.
   * Measurements: none.
   * Bounded-frequency: at-most-once per (page load, SW activation)
   *   pair - typically once per page load.
   */
  'sw.activated',

  /**
   * Severity: warn
   * Fired by: rejection path of
   *           `navigator.serviceWorker.register('/sw.js')` in
   *           `registerServiceWorker`
   *           (`core/telemetry/sw-registration.ts`).
   * Props:
   *   - { version, sha, branch, buildNumber }: build identity per
   *     the carve-out in the preamble.
   *   - { reason: 'security' | 'syntax' | 'fetch' | 'type'
   *               | 'network' | 'abort' | 'other' }. Closed-enum
   *     classification via `classifyRegistrationError(err)`. No
   *     raw error message is logged (closed-enum rule).
   * Measurements: none.
   * Bounded-frequency: one per page load.
   */
  'sw.registerFailed',

  /**
   * Severity: event
   * Fired by: `src/main.ts` pre-bootstrap block when
   *           `readAndClearLegacyCacheSentinel()` resolves true.
   *           The SW writes the IndexedDB sentinel
   *           (`jotjson-sw-migration/sentinel/legacyCacheWiped`) on
   *           activate-with-non-empty-cache; NEW `main.ts` reads
   *           and deletes the sentinel at boot. The sentinel
   *           survives the navigation boundary from OLD `main.ts`
   *           (which has no message listener) to NEW `main.ts` -
   *           a postMessage from the SW would be silently dropped
   *           on that boundary, so IndexedDB is the only mechanism
   *           that works.
   *
   * THE canonical "stuck user successfully migrated" signal.
   * Props:
   *   - { version, sha, branch, buildNumber }: build identity per
   *     the carve-out in the preamble.
   *   - { browser: 'chrome' | 'edge' | 'firefox' | 'safari'
   *               | 'other';
   *       os: 'windows' | 'mac' | 'linux' | 'android' | 'ios'
   *           | 'other' }. Closed-enum buckets so cohort-specific
   *     regressions (e.g. Safari-only Monaco bug) are visible.
   * Measurements: none.
   * Bounded-frequency: at-most-once per stuck-user migration
   *   (lifetime bounded; the OLD ngsw cohort is finite).
   */
  'sw.legacyCacheWiped',

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
   * Fired by: `HomeComponent.onEditorPaste`
   *           (`features/home/home.component.ts`) on every native
   *           Monaco paste inside the editor. Distinct from
   *           `paste.handle` (toolbar paste) - the editor path does
   *           NOT read the clipboard (Monaco's `onDidPaste` fires
   *           with the already-pasted text), so `clipboardReadMs`
   *           is absent by design. Bounded-frequency: one event
   *           per Monaco paste action regardless of whether the
   *           post-paste buffer parses.
   * Props: { sizeBytesBucket: SizeBucket } via `bucketBytes` over
   *   the UTF-8 byte count of the pasted region only (NOT the full
   *   post-paste buffer).
   * Measurements: { sizeBytes: number; parseMs: number;
   *   syncHandlerMs: number; firstPaintMs: number }.
   *   - `parseMs`: synchronous time spent in
   *     `JsonExtractorService.extractFromMixedText` over the pasted
   *     region. 0 when `postPasteParses` is true (no extraction
   *     attempted because the full buffer already parses).
   *   - `syncHandlerMs`: T0 to end-of-synchronous-handler.
   *   - `firstPaintMs`: T0 to first painted frame after the handler
   *     completes, via double `requestAnimationFrame`. The
   *     user-perceived end-to-end latency.
   */
  'paste.handle.editor',

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
   * Kind: event
   * Fired by: `HomeComponent.replaceExtractedCandidate`
   *           (`features/home/home.component.ts`) when a non-null
   *           extracted-JSON candidate is installed and the M7p
   *           extract banner therefore becomes visible.
   * Props: { source: 'paste' | 'editor.paste' | 'upload.pick'
   *   | 'upload.drag' }. `'paste'` = toolbar Paste button (clipboard
   *   read); `'editor.paste'` = native Monaco paste inside the
   *   editor; `'upload.pick'` = toolbar Upload button; `'upload.drag'`
   *   = files dropped onto the document.
   * Measurements: { blockCount: number; preservesComments: 0 | 1;
   *   hasComments: 0 | 1; proseSegments: number }. `blockCount` is the
   *   number of JSON blocks the extractor recovered from the mixed
   *   text. `preservesComments` is 1 when the extractor's output
   *   FORMAT retains comments (single-block always 1; multi-block
   *   always 0) and 0 otherwise. `hasComments` is 1 when at least one
   *   accepted candidate's source slice contained a JSONC comment and
   *   0 otherwise. The product `hasComments && !preservesComments`
   *   (i.e., `hasComments=1 && preservesComments=0`) is exactly when
   *   the banner shows the "Comments will be dropped" warning.
   *   `proseSegments` is the count of non-whitespace prose segments
   *   preserved in the wrapper output (0 when the input has no
   *   surrounding prose, in which case the result is the bare value
   *   or bare array; >0 when the wrapper carries `prefix`/`suffix`/
   *   `between_<i>_and_<j>` keys). Numeric so AI can `avg()` /
   *   `sum()` them.
   */
  'home.extract.banner.shown',

  /**
   * Kind: event
   * Fired by: `HomeComponent.onExtractAccept`
   *           (`features/home/home.component.ts`) when the user
   *           clicks the banner's Extract button. Emitted before
   *           the candidate is cleared and `setContent` is called,
   *           so the banner-replace path inside `setContent` does
   *           NOT additionally fire `home.extract.banner.dismiss`
   *           with `reason='content.changed'` for this candidate.
   * Props: { source: 'paste' | 'editor.paste' | 'upload.pick'
   *   | 'upload.drag' } - mirrors `home.extract.banner.shown`.
   * Measurements: { blockCount: number; preservesComments: 0 | 1;
   *   hasComments: 0 | 1; proseSegments: number } - mirrors
   *   `home.extract.banner.shown` so accept-rate by block-count,
   *   comments-preservation, warning-exposure, and prose presence
   *   can be computed by a join.
   */
  'home.extract.banner.accept',

  /**
   * Kind: event
   * Fired by: `HomeComponent` whenever a previously-visible M7p
   *           extract banner becomes invisible.
   *           - `onExtractDismiss` (the user clicked the banner's
   *             Dismiss button, or pressed Esc): `reason='user.click'`.
   *           - `setContent` and `replaceExtractedCandidate`: the
   *             content version bumped (typing, format, hydrate,
   *             clear) or a fresh paste/upload installed a new
   *             candidate that replaces the old one:
   *             `reason='content.changed'`.
   *           Accept does NOT emit this event - see
   *           `home.extract.banner.accept`.
   * Props: { source: 'paste' | 'editor.paste' | 'upload.pick'
   *   | 'upload.drag'; reason: 'user.click' | 'content.changed' }.
   *   `source` is whatever path produced the candidate that is now
   *   being dismissed (carried on the `extractedCandidate` signal).
   * Measurements: { blockCount: number; proseSegments: number }.
   *   Accept-vs-dismiss skew by block-count and prose presence.
   *   `preservesComments` is intentionally not replicated here since
   *   it is queryable via the matching `home.extract.banner.shown`
   *   event for the same source/session (one-to-one prior to
   *   dismiss).
   */
  'home.extract.banner.dismiss',

  /**
   * Kind: event
   * Fired by: `HomeComponent` cold-boot evaluator
   *           (`features/home/home.component.ts`) when the
   *           cold-boot clipboard banner becomes visible -
   *           preference is `'ask'`, the route is `/`, clipboard
   *           permission is `'granted'`, and the clipboard text
   *           parses as a top-level JSON object/array below the
   *           1MB cap. One-shot per cold boot.
   * Props: none. Cold-boot context is implied by the message id.
   * Measurements: none.
   */
  'home.clipboard.coldBoot.prompt.shown',

  /**
   * Kind: event
   * Fired by: `HomeComponent` cold-boot evaluator
   *           (`features/home/home.component.ts`) when the user
   *           interacts with the cold-boot clipboard banner.
   *           Always paired with a preceding
   *           `home.clipboard.coldBoot.prompt.shown` in the same
   *           cold boot.
   * Props: { choice: 'always' | 'just-this-time' | 'never'
   *   | 'dismiss' }. `'always'` and `'never'` set the persisted
   *   `coldBootClipboardAutoPaste` preference; `'just-this-time'`
   *   pastes once without changing the preference; `'dismiss'`
   *   covers the X icon, Esc, and click-outside paths (no paste,
   *   no preference change, ask again next cold boot).
   * Measurements: none.
   */
  'home.clipboard.coldBoot.prompt.choice',

  /**
   * Kind: event
   * Fired by: `HomeComponent` cold-boot evaluator
   *           (`features/home/home.component.ts`) when the silent
   *           auto-paste path fires - preference is `'always'`,
   *           clipboard permission is `'granted'`, and the
   *           clipboard text parses as a top-level JSON
   *           object/array below the 1MB cap. The bootstrap
   *           splash is held briefly (max 150ms) so the swap
   *           happens before first paint; a successful fire here
   *           means the read won the race and the snackbar
   *           "Pasted from clipboard. Undo." is shown. One-shot
   *           per cold boot; bounded by user gesture (one cold
   *           boot per process) so volume is naturally limited.
   * Props: { sizeBytesBucket: ReturnType<typeof bucketBytes> }.
   *   Closed-enum size bucket of the clipboard payload (e.g.
   *   `'<1KB'`, `'1-10KB'`, ...). Bucket goes in props; the raw
   *   numeric value is in measurements.
   * Measurements: { sizeBytes: number }. Raw UTF-8 byte count of
   *   the clipboard text we applied. Mirrors the `paste.handle`
   *   shape so KQL can `avg(sizeBytes)` across both paths.
   */
  'home.clipboard.coldBoot.autoPaste',

  /**
   * Kind: event
   * Fired by: `HomeComponent` snackbar Undo handler
   *           (`features/home/home.component.ts`) when the user
   *           clicks Undo on the cold-boot auto-paste snackbar.
   *           Bounded by user gesture (one click per
   *           auto-paste). Always paired with a preceding
   *           `home.clipboard.coldBoot.autoPaste` in the same
   *           cold boot.
   * Props: none.
   * Measurements: none.
   */
  'home.clipboard.coldBoot.autoPaste.undo',

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

  /**
   * Kind: event
   * Fired by: `shareBlobResolver`
   *           (`features/share/share-blob.resolver.ts`) after the
   *           terminal blob is resolved (success path only -- the
   *           4xx/error path navigates to /404 via `goToNotFound`
   *           and does not emit this event).
   * Props: { determinateProgress: boolean }. `true` when the resolver
   *   observed a non-null `total` (from `X-Jotjson-Body-Length`) at
   *   any point during the fetch, `false` otherwise. Used to spot
   *   regressions if AFD configuration drifts at the edge fleet
   *   level and starts stripping the custom header.
   * Measurements: none.
   */
  'blob.fetch.complete',

  /**
   * Kind: event
   * Fired by: `LoadingSplashService.markBlobRenderComplete`
   *           (`core/loading-splash/loading-splash.service.ts`)
   *           when called while `renderPending === true`. The
   *           `markBlobRenderComplete` call is wired into
   *           `HomeComponent`'s constructor via
   *           `afterNextRender` + double `requestAnimationFrame`,
   *           so the event fires exactly when the user has actually
   *           seen the first paint of the JSON tree on a cold-boot
   *           deep-link to `/s/:slug`. The idempotent guard ensures
   *           in-app `/` -> `/s/:slug` navigations (which mount a
   *           fresh `HomeComponent` and re-fire the hook) do NOT
   *           emit -- `renderPending` is only set on the first
   *           cold-boot blob nav.
   *
   *           One-shot per session (cold-boot blob deep-link is the
   *           only path that sets `renderPending=true`, and the
   *           `firstNavComplete` latch prevents subsequent navs from
   *           re-triggering it).
   * Props: none.
   * Measurements: { durationMs: number }
   *   - elapsed wallclock time in ms from `markBlobBytesComplete`
   *     (when `BlobService` signals the body bytes have arrived,
   *     immediately before its synchronous `JSON.parse`) to the
   *     moment the double-rAF callback fires
   *     `markBlobRenderComplete` (i.e., the frame after first paint).
   *     Covers the JSON.parse window + resolver finalization +
   *     route activation + `HomeComponent` construction +
   *     change-detection + browser paint -- the full heavy-work
   *     window the user is actually waiting on.
   *
   *     Note: prior to v0.10.7 this measured `NavigationEnd` ->
   *     first paint, which excluded the synchronous JSON.parse
   *     (the dominant contributor on multi-MB blobs). KQL
   *     dashboards plotting `durationMs` across the v0.10.6 ->
   *     v0.10.7 boundary should expect a step increase.
   *
   *     Raw value; use `percentile(durationMs, 50)` /
   *     `percentile(durationMs, 95)` in KQL to track the
   *     post-fetch render-time distribution and inform whether
   *     virtualized tree rendering becomes a priority.
   */
  'blob.coldBoot.firstPaint',

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
   * Severity: error
   * Fired by: `LoggerService.flushSessionStorage` via direct
   *           `telemetry.trackException(..., {messageId})` in
   *           `core/telemetry/logger.service.ts` (does NOT route
   *           through `logger.error`). Replays a `{name, message}`
   *           shape persisted to `sessionStorage` by
   *           `postAuthResponseToParent` in
   *           `core/auth/msal-iframe-bridge.ts` when the
   *           silent-refresh iframe's call to
   *           `broadcastResponseToMainFrame()` (from the
   *           `@azure/msal-browser/redirect-bridge` subpath export)
   *           rejected. The parent surfaces `redirect_bridge_timeout`
   *           independently; this event is the diagnostic channel
   *           telling us *why* the iframe-side bridge call failed
   *           (parse error, missing state, missing id/meta, etc.).
   * Props: none. (The `messageId` tag is attached to the
   * `trackException` envelope, not as `props`. The `{name, message}`
   * shape lands in the exception body.)
   * Exception: a `{name, message}` shape reconstructed from
   * `sessionStorage[BRIDGE_FAIL_KEY]`.
   *
   * LEGACY: removed when the `/blank.html` redirect URI migration
   * (issue #230) ships and the compensating code in
   * `msal-iframe-bridge.ts` is deleted.
   */
  'auth.msalBridge.failed',

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
   * NOT in this enum: theme toggle, selection-sync toggle,
   * pane-layout segmented control. Those mutate preferences and
   * surface via `pref.changed` instead.
   *
   * Props: { action: <closed-enum above> }.
   * Measurements: none.
   */
  'toolbar.action',

  /**
   * Kind: event
   * Fired by: `ToolbarComponent.onSuggestionSelected`
   *           (`shared/components/toolbar/toolbar.component.ts`) when
   *           the user accepts (clicks) one of the suggestions in
   *           the title-suggestion menu. Fired ONLY on selection --
   *           neither opening the menu, hovering items, nor dismissing
   *           it without a selection emits this event.
   *
   * Privacy: AGENTS.md S6. The candidate's literal text is NEVER
   * logged. Only the strategy `source` (which is a closed enum from
   * `core/title-suggester/types.ts`) and the menu's total candidate
   * count are recorded. The strategy enum is a fixed list, not
   * user-derived, so cardinality is bounded.
   *
   * Props: { source: SuggestionSource } where SuggestionSource is
   *   the closed enum from `core/title-suggester/types.ts`:
   *   `filename | packageJson | kubernetes | openapi | jsonSchema |
   *    geojson | armTemplate | tsconfig | githubActionsWorkflow |
   *    postmanCollection | selfUrl | namedField | typeField |
   *    topLevelKeys | descriptionFallback | arrayShape | objectShape |
   *    primitive | firstChars | untitled | dateStamped |
   *    numberedUntitled`.
   * Measurements: { candidateCount: number } -- raw 2..7, the size
   *   of the menu the user picked from (post-cap, post-floor). Useful
   *   for understanding whether users pick the first option or scan
   *   the whole list.
   */
  'toolbar.titleSuggestionAccepted',

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
   *                      searchValueType, searchMatchMode,
   *                      blobQuotaStrategy, treePathRoot.
   *   kind = 'boolean' : { value: 'true' | 'false' }.
   *   kind = 'number'  : { valueBucket: <bounded bucket string> };
   *                      measurement { value: number }.
   *   kind = 'count'   : { countBucket: CountBucket };
   *                      measurement { count: number }. Used for
   *                      `activeRuleSetIds`.
   *   kind = 'color'   : { isDefault: 'true' | 'false';
   *                        bucket: ColorBucket }.
   *                      ColorBucket = 'red' | 'orange' | 'yellow'
   *                        | 'green' | 'teal' | 'blue' | 'purple'
   *                        | 'pink' | 'gray' | 'custom'. Raw hex
   *                      is NEVER logged -- only the coarse named
   *                      bucket plus a default-flag.
   */
  'pref.changed',

  /**
   * Kind: event
   * Fired by: `PreferencesService` (`core/preferences/preferences.service.ts`)
   *           at the three lifecycle moments when the resolved
   *           ("effective") color theme has been applied to the
   *           user's view:
   *           - Once at service construction (`source: 'boot'`),
   *             browser-only.
   *           - When the OS `prefers-color-scheme` flips while the
   *             stored preference is `'system'` (`source: 'osChange'`).
   *           - When `applyPrefs` mutates state in a way that moves
   *             the effective theme; `source` mirrors the
   *             upstream `PreferenceChangeSource` (`'user' | 'init'
   *             | 'sync'`) so sign-in hydration and a future
   *             server-pushed sync are correctly distinguished from
   *             a user click. `'init'` covers both sign-in
   *             hydration and sign-out reset.
   *
   * This event exists because `pref.changed` records the stored
   * preference (`'system' | 'dark' | 'light'`), which is dominated
   * by `'system'` (the default) -- so it cannot answer "what color
   * scheme is actually being rendered?". `theme.applied` records
   * the resolved value after `matchMedia('(prefers-color-scheme:
   * light)')` is consulted.
   *
   * Dedupe: emits only when the resolved theme differs from the
   * last emitted value, except `source: 'boot'` always emits (so
   * every session has a baseline data point). The dedupe means
   * `applyPrefs` calls that don't move the effective theme
   * (e.g., `dark` -> `system` on a dark-mode OS) do NOT fire.
   *
   * Volume control: bounded-frequency. Boot is one-shot per
   * service-instance (~1 per browser tab). OS-flips and user pref
   * clicks are user-bounded; `init` is bounded by auth-state
   * transitions per session.
   *
   * Props: {
   *   effective: 'dark' | 'light';
   *   pref: 'system' | 'dark' | 'light';
   *   source: 'boot' | 'osChange' | 'user' | 'init' | 'sync';
   * }
   *   All closed-enum. Cardinality bound: 2 x 3 x 5 = 30 combos;
   *   reachable combos are fewer because `pref in {dark, light}`
   *   pins `effective`. No PII, no per-user / per-session IDs.
   * Measurements: none.
   */
  'theme.applied',

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
   * Props: { ruleCount: number; pairRuleCount: number;
   *   predicateRuleCount: number }.
   * `pairRuleCount` and `predicateRuleCount` are coarse counts only;
   * no key strings, match values, match types, or predicate identities
   * are logged.
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
   *           `activeRuleSetIds` (`core/api/rule-sets.service.ts`).
   *           Skips the first run after hydration so steady-state
   *           startup doesn't emit a spurious event.
   * Props: { activeCount: number }. Cardinality of active rule sets
   * after the change.
   */
  'ruleSets.applied',

  // Tree string extractor (M7s)

  /**
   * Severity: warn
   * Fired by: `TreeStringExtractorService.handleWorkerFailure`
   *           (`core/json/tree-string-extractor.service.ts`) when the
   *           Web Worker cannot be created, cannot accept a scan request,
   *           errors, or reports a structured-clone message failure.
   * Props: { reason: 'factory' | 'postMessage' | 'error' | 'messageerror' }.
   */
  'tree.stringExtractor.workerUnavailable',

  /**
   * Kind: event
   * Fired by: `HomeComponent.emitTreeExtractShownTelemetryIfPending`
   *           (`features/home/home.component.ts`) once a debounced tree
   *           string-leaf scan has completed for the current source version.
   * Props: none.
   * Measurements: { uniqueStringsScanned: number; uniqueCandidates: number;
   *   candidateNodes: number }. `candidateNodes` counts visible string rows
   *   whose raw value has an extractable replacement; user strings and paths
   *   are never logged.
   */
  'tree.extract.shown',

  /**
   * Kind: event
   * Fired by: `JsonTreeComponent.openDecodedDialog`
   *           (`shared/components/json-tree/json-tree.component.ts`)
   *           when the user opens the dedicated decoded-value viewer
   *           dialog for a string leaf. The dialog renders the raw
   *           string with line numbers and a copy button; the row
   *           itself stays one line tall. Replaces the prior in-row
   *           toggle (issue #95 Phase 0): tree-row virtualization
   *           requires uniform row height, so the inline "show as
   *           decoded text" affordance was promoted to a dialog. The
   *           three earlier tokens (`tree.decoded.click`,
   *           `tree.contextMenu.decodeShow`,
   *           `tree.contextMenu.decodeHide`) were retired in the same
   *           change; this token consolidates their signal.
   * Volume control: bounded-frequency. Fires once per dialog open
   * (one user click on the row pill or the kebab-menu item). No
   * "close" companion event - close is implicit (Esc, backdrop, or
   * the Close button) and carries no analytic value.
   * Props: { source: 'rowButton' | 'contextMenu';
   *          reason: 'escape' | 'long';
   *          pathDepth: '<100' | '100-1K' | '1K-10K' | '>10K';
   *          lineCountBucket: '1' | '2-5' | '6-20' | '21-100' | '100+' }.
   *          `source` distinguishes the in-row pill from the kebab
   *          context-menu entry; `reason` says whether the predicate
   *          matched escape characters (`escape`) or only the
   *          length > 256 fallback (`long`); `pathDepth` is the
   *          bucketed depth of the originating row's path; user
   *          string contents and raw paths are never logged.
   *
   * Note: this event's `source: 'rowButton'` cohort remains the row
   * Decoded pill click and is NOT comparable to
   * `tree.extract.click`'s former `rowButton` cohort after this
   * milestone. Cross-event joins on `source` must use the new mapping.
   */
  'tree.decoded.viewerOpened',

  /**
   * Kind: event
   * Fired by: `HomeComponent.onExtractRequest`
   *           (`features/home/home.component.ts`) after a non-stale tree
   *           extract click patches the editor text successfully.
   * Props: { source: 'rowPillPrimitiveArray' | 'contextMenu' | 'decodedDialog' }.
   * Note: `source: 'rowButton'` was intentionally renamed to
   * `rowPillPrimitiveArray` in M7v. This is a deliberate loud break:
   * dashboards filtering on `rowButton` will go to zero after deploy.
   * `decodedDialog` fires when extract is invoked from the Decoded Value
   * dialog. See `tree.decoded.viewerOpened` for the non-comparable
   * cohort note.
   * Measurements: { blockCount: number; proseSegments: number }.
   */
  'tree.extract.click',

  /**
   * Severity: warn
   * Fired by: `HomeComponent.onExtractRequest`
   *           (`features/home/home.component.ts`) when a tree extract click
   *           belongs to an older source version than the current scan.
   * Props: { eventVersion: number; currentVersion: number }.
   */
  'tree.extract.staleClick',

  /**
   * Severity: warn
   * Fired by: `HomeComponent.onExtractRequest`
   *           (`features/home/home.component.ts`) when a tree extract click
   *           cannot be spliced into the current editor text.
   * Props: { reason: 'extract.patch.parse-failed' | 'extract.patch.path-not-found'
   *   | 'unknown' }.
   */
  'tree.extract.applyFailed',

  // Tree extract undo (M7v)

  /**
   * Kind: event
   * Fired by: `HomeComponent` (`features/home/home.component.ts`) on
   *           snackbar Undo click or when Ctrl+Z is detected within
   *           ~1 turn of a successful extract.
   * Volume control: bounded-frequency. At most one user action per
   * extract, with keyboard detection opt-in.
   * Props: { source: 'snackbar' | 'ctrlZ';
   *          undoLatencyMsBucket: '<1s' | '1-5s' | '5s+' }.
   *          `source` distinguishes the entry path; `undoLatencyMsBucket`
   *          supports a misclick-rate KQL where undo within 5s is the
   *          approximate signal. The `'5s+'` top bucket is open-ended
   *          because `pendingExtractUndo` is released by a 30s wall-clock
   *          timer; reverts past 30s only land when background-tab
   *          throttling delays the timer.
   * Privacy: no string contents or paths.
   */
  'tree.extract.undo',

  /**
   * Kind: event
   * Fired by: `HomeComponent.onSortKeysRequest`
   *           (`features/home/home.component.ts`) when the right-click
   *           Sort patcher succeeds or reports `alreadySorted: true`.
   * Volume control: bounded-frequency. One per non-throwing right-click
   *   Sort attempt.
   * Props: { alreadySorted: 'true' | 'false';
   *          keyCountBucket: CountBucket }.
   *          `alreadySorted` is a closed-enum string, not a boolean;
   *          `keyCountBucket` comes from `bucketCount` over the targeted
   *          object's immediate-key count.
   * Privacy: no path, no key names, no document contents.
   */
  'tree.sortKeys.click',

  /**
   * Severity: warn
   * Fired by: `HomeComponent.onSortKeysRequest`
   *           (`features/home/home.component.ts`) when the patcher throws
   *           or `editor().applyEdit(...)` fails.
   * Props: { reason: 'parseFailed' | 'pathNotFound' | 'notObject'
   *   | 'editorUnavailable' | 'applyEditFailed' }.
   * Privacy: no path, no document contents.
   */
  'tree.sortKeys.applyFailed',

  /**
   * Severity: error
   * Fired by: `HomeComponent.onSortKeysRequest`
   *           (`features/home/home.component.ts`) default branch of the
   *           patcher-error switch, when the thrown error does not match
   *           any of the four documented `sort.patch.*` discriminators.
   * Props: { source: 'patcher' }. Closed-enum; no raw exception message
   *   leaks into `customDimensions`. The original cause is captured in
   *   App Insights `exceptions` via `logger.error`'s second argument.
   * Exception: any value caught from `patchSortKeysAtPath(...)` whose
   *   `error.message` is not one of `sort.patch.parse-failed`,
   *   `sort.patch.path-not-found`, `sort.patch.not-object`, or
   *   `sort.patch.empty-or-single`. Indicates either a patcher contract
   *   regression (e.g. a new throw added without updating the handler)
   *   or an unexpected runtime fault (e.g. an internal jsonc-parser
   *   error, OOM). Distinct from `applyFailed` warnings to keep the
   *   closed-enum `warn` channel clean of unknown-shape signals.
   * Privacy: stack and message land in `exceptions` (not
   *   `customDimensions`), where the privacy initializer in
   *   `TelemetryService` continues to apply.
   */
  'tree.sortKeys.unexpectedError',

  /**
   * Kind: event
   * Fired by: `HomeComponent` (`features/home/home.component.ts`) on
   *           snackbar Undo click or content revert via Ctrl+Z.
   * Volume control: bounded-frequency. One per right-click Sort that
   *   gets undone.
   * Props: { source: 'snackbar' | 'ctrlZ';
   *          undoLatencyMsBucket: '<1s' | '1-5s' | '5s+' }.
   *          Mirrors `tree.extract.undo`.
   * Measurements: { undoLatencyMs?: number }. Raw wall-clock latency
   *   from apply to undo when available.
   * Privacy: no path, no document contents.
   */
  'tree.sortKeys.undo',

  /**
   * Kind: event
   * Fired by: `HomeComponent` (`features/home/home.component.ts`) on
   *           snackbar Undo click or when Ctrl+Z (or any other content
   *           reset that restores the pre-extract text without bumping
   *           `viewResetToken`) brings the editor back to the
   *           pre-extract text within ~30s of a successful banner-accept
   *           extract.
   * Volume control: bounded-frequency. At most one undo per
   *   banner-accept extract; capped at 30s by `pendingExtractUndo`.
   * Props: { source: 'snackbar' | 'ctrlZ';
   *          pasteSource: 'paste' | 'editor.paste' | 'upload.pick' | 'upload.drag';
   *          undoLatencyMsBucket: '<1s' | '1-5s' | '5s+' }.
   *          `source` distinguishes the undo entry path; `pasteSource`
   *          mirrors `home.extract.banner.{shown,accept}` so an
   *          accept-rate vs undo-rate-by-origin KQL is a clean join.
   *          `undoLatencyMsBucket` mirrors `tree.extract.undo` so a
   *          misclick-rate query works the same way across both
   *          extract surfaces.
   * Privacy: no string contents or paths.
   */
  'home.extract.banner.undo',

  /**
   * Severity: warn
   * Fired by: `HomeComponent.onExtractAccept`
   *           (`features/home/home.component.ts`) when the editor's
   *           `applyEdit` primitive cannot splice the extracted document
   *           in place; the component falls back to a full setValue
   *           replacement via `replaceDocument` so the user still gets
   *           the extract result, and the snackbar is still opened so
   *           snackbar-Undo (which goes through `replaceDocument`)
   *           remains available even though Monaco-native Ctrl+Z is
   *           lost on this branch.
   * Props: { reason: 'editorUnavailable' | 'applyEditFailed' }. Mirrors
   *   `tree.extract.applyFailed`.
   */
  'home.extract.banner.applyFailed',

  /**
   * Kind: event
   * Fired by: `HomeComponent` (`features/home/home.component.ts`) on
   *           snackbar Undo click in `openReplaceUndoSnack` and in the
   *           constructor effect when the editor content reverts to the
   *           pre-upload text via Ctrl+Z (or another non-snackbar undo
   *           path) while the pending replace-undo window is still open.
   * Volume control: bounded-frequency. One event per upload replace
   *   action that is undone.
   * Props: { source: 'snackbar' | 'ctrlZ'; trigger: 'pick' | 'drag';
   *          undoLatencyMsBucket: '<1s' | '1-5s' | '5s+' }.
   *          `source` distinguishes the undo entry path; `trigger`
   *          preserves whether the original replacement came from the
   *          file picker or drag-drop; `undoLatencyMsBucket` supports
   *          misclick-rate queries without using raw time as a
   *          dimension.
   * Measurements: { undoLatencyMs?: number }. Raw wall-clock latency
   *   from replacement apply to undo when available.
   * Privacy: no filenames or document contents.
   */
  'home.upload.undo',

  /**
   * Severity: warn
   * Fired by: `HomeComponent` (`features/home/home.component.ts`) when
   *           the upload-replacement path cannot apply Monaco edits in
   *           place and falls back to a full document replacement,
   *           which preserves the uploaded content but loses
   *           Monaco-native Ctrl+Z.
   * Volume control: bounded-frequency. One warn per upload replace
   *   action that falls back to full replacement. Not emitted on the
   *   no-op path (when uploaded content equals the current editor
   *   content): that branch short-circuits silently with no warn and
   *   no fallback.
   * Props: { reason: 'editorNotReady' | 'modelNull' | 'editsRejected' }.
   *   Closed-enum reason for the in-place apply failure.
   *   `editorNotReady`: the wrapper editor signal returned null.
   *   `modelNull`: `replaceAll` returned `'modelNull'` (Monaco
   *   namespace or model unavailable). `editsRejected`: `replaceAll`
   *   returned `'editsRejected'` (Monaco's `executeEdits` reported the
   *   edit did not apply).
   */
  'home.upload.applyFailed',

  /**
   * Kind: event
   * Fired by: `HomeComponent` (`features/home/home.component.ts`) on
   *           snackbar Undo click in `openReplaceUndoSnack` and in the
   *           constructor effect when the editor content reverts to the
   *           pre-format text via Ctrl+Z (or another non-snackbar undo
   *           path) while the pending replace-undo window is still open.
   * Volume control: bounded-frequency. One event per format replace
   *   action that is undone.
   * Props: { source: 'snackbar' | 'ctrlZ';
   *          undoLatencyMsBucket: '<1s' | '1-5s' | '5s+' }.
   *          `source` distinguishes the undo entry path;
   *          `undoLatencyMsBucket` supports misclick-rate queries
   *          without using raw time as a dimension.
   * Measurements: { undoLatencyMs?: number }. Raw wall-clock latency
   *   from replacement apply to undo when available.
   * Privacy: no document contents.
   */
  'home.format.undo',

  /**
   * Severity: warn
   * Fired by: `HomeComponent` (`features/home/home.component.ts`) when
   *           the format-replacement path cannot apply Monaco edits in
   *           place and falls back to a full document replacement,
   *           which preserves the formatted content but loses
   *           Monaco-native Ctrl+Z.
   * Volume control: bounded-frequency. One warn per format replace
   *   action that falls back to full replacement. Not emitted on the
   *   no-op path (when the formatter output equals the current editor
   *   content): `onFormat` short-circuits at the caller before this
   *   path is reached.
   * Props: { reason: 'editorNotReady' | 'modelNull' | 'editsRejected' }.
   *   Closed-enum reason for the in-place apply failure. See
   *   `home.upload.applyFailed` for the reason semantics.
   */
  'home.format.applyFailed',

  /**
   * Kind: event
   * Fired by: `HomeComponent` (`features/home/home.component.ts`) on
   *           snackbar Undo click in `openReplaceUndoSnack` and in the
   *           constructor effect when the editor content reverts to the
   *           pre-minify text via Ctrl+Z (or another non-snackbar undo
   *           path) while the pending replace-undo window is still open.
   * Volume control: bounded-frequency. One event per minify replace
   *   action that is undone.
   * Props: { source: 'snackbar' | 'ctrlZ'; priorMode: 'json' | 'jsonc';
   *          undoLatencyMsBucket: '<1s' | '1-5s' | '5s+' }.
   *          `source` distinguishes the undo entry path; `priorMode`
   *          preserves whether minify replaced JSON or JSONC text;
   *          `undoLatencyMsBucket` supports misclick-rate queries
   *          without using raw time as a dimension.
   * Measurements: { undoLatencyMs?: number }. Raw wall-clock latency
   *   from replacement apply to undo when available.
   * Privacy: no document contents.
   */
  'home.minify.undo',

  /**
   * Severity: warn
   * Fired by: `HomeComponent` (`features/home/home.component.ts`) when
   *           the minify-replacement path cannot apply Monaco edits in
   *           place and falls back to a full document replacement,
   *           which preserves the minified content but loses
   *           Monaco-native Ctrl+Z.
   * Volume control: bounded-frequency. One warn per minify replace
   *   action that falls back to full replacement. Not emitted on the
   *   no-op path. `onMinify` short-circuits at the caller when the
   *   minifier output equals the current editor content *and* the
   *   mode is already `'json'`; the JSONC-mode-already-minified case
   *   falls through into `applyReplaceWithFallback`, where the inner
   *   `'noOp'` branch suppresses the warn so the only observable
   *   change (mode flip) still gets its snackbar.
   * Props: { reason: 'editorNotReady' | 'modelNull' | 'editsRejected' }.
   *   Closed-enum reason for the in-place apply failure. See
   *   `home.upload.applyFailed` for the reason semantics.
   */
  'home.minify.applyFailed',

  /**
   * Kind: event
   * Fired by: `HomeComponent.onSort` (`features/home/home.component.ts`)
   *           after a successful toolbar Sort replacement.
   * Volume control: bounded-frequency. One per Sort button click that
   *   produces a replacement.
   * Props: { keyCountBucket: CountBucket }.
   *   `keyCountBucket` comes from `bucketCount` over the root object's
   *   top-level key count, or 0 when the root is not an object. Note:
   *   the whole-document Sort recursively reorders every multi-key
   *   object body, so the actual count of sorted objects may be much
   *   higher than the root key count. This dimension reflects root
   *   surface area, not total work.
   * Privacy: no document contents, no key names.
   */
  'home.sort.click',

  /**
   * Kind: event
   * Fired by: `HomeComponent` (`features/home/home.component.ts`) on
   *           snackbar Undo click or when Ctrl+Z reverts the editor to
   *           the pre-sort text within the pending-replace-undo window.
   * Volume control: bounded-frequency. One per toolbar Sort that gets
   *   undone; capped at 30 s via `REPLACE_UNDO_CAP_MS`.
   * Props: { source: 'snackbar' | 'ctrlZ'; priorMode: 'json' | 'jsonc';
   *          undoLatencyMsBucket: '<1s' | '1-5s' | '5s+' }.
   *          Mirrors `home.minify.undo`.
   * Measurements: { undoLatencyMs?: number }. Raw wall-clock latency
   *   from replacement apply to undo when available.
   * Privacy: no document contents.
   */
  'home.sort.undo',

  /**
   * Severity: warn
   * Fired by: `HomeComponent.onSort` / `applyReplaceWithFallback`
   *           (`features/home/home.component.ts`) when Monaco edits
   *           cannot be applied. Not emitted for parse-error or
   *           empty-doc early returns, matching `onMinify` / `onFormat`.
   * Props: { reason: 'editorNotReady' | 'modelNull' | 'editsRejected' }.
   */
  'home.sort.applyFailed',

  /**
   * Kind: event
   * Fired by: `JsonTreeComponent.onDecodedButtonClick` /
   *           `JsonTreeComponent.onDecodedMenuClick`
   *           (`shared/components/json-tree/json-tree.component.ts`)
   *           inside the shared `dialogRef.afterClosed()` subscription
   *           when the user clicks the dialog's Extract button but the
   *           captured source-version no longer matches
   *           `extractSourceVersion()` at close time; a background tree
   *           re-scan invalidated the candidate while the dialog was open.
   * Volume control: bounded-frequency. Bounded by decoded-dialog
   * Extract click frequency.
   * Props: none.
   * Privacy: no content.
   */
  'tree.extract.dialog.staleClose',

  /**
   * Kind: event
   * Fired by: `HomeComponent.openExtractUndoSnack`
   *           (`features/home/home.component.ts`) when a second extract
   *           opens while the prior snackbar ref is still live; the
   *           prior snackbar is dismissed before the new one opens.
   *           Fires for ALL cross-extract snackbar replacements - i.e.
   *           tree->tree, tree->banner, banner->tree, banner->banner.
   *           The legacy event name retains the `tree.` prefix from
   *           M7v even though banner-extract also triggers it; renaming
   *           would break dashboards keyed off the existing namespace
   *           per AGENTS.md s4 ("Pick the right sink up front -
   *           migrating later breaks history"). `from`/`to` props
   *           disambiguate the surfaces.
   * Volume control: bounded-frequency. Bounded by double-extract
   * frequency while the prior snackbar is still active (rare).
   * Props: { from: 'tree' | 'banner'; to: 'tree' | 'banner' }. The
   *   surface of the snackbar being dismissed (`from`) and the
   *   surface of the snackbar being opened (`to`). Cross-combos are
   *   the motivating signal: e.g., banner->tree means the user
   *   accepted the banner, then promptly extracted a tree row before
   *   the banner snackbar timed out.
   * Privacy: no content.
   */
  'tree.extract.snackbarReplaced',

  /**
   * Kind: event
   * Fired by: `HomeComponent.openReplaceUndoSnack`
   *           (`features/home/home.component.ts`) when a second
   *           replace-undo snackbar opens while the prior snackbar ref
   *           is still live; the prior snackbar is dismissed before the
   *           new one opens.
   * Volume control: bounded-frequency. One event per replace-undo
   *   snackbar replacement while a prior snackbar is still active.
   * Props: { from: 'upload' | 'format' | 'minify' | 'extract.banner'
   *          | 'extract.tree' | 'coldBoot'; to: 'upload' | 'format'
   *          | 'minify' | 'extract.banner' | 'extract.tree'
   *          | 'coldBoot' }.
   *          `from` is the snackbar being dismissed; `to` is the new
   *          snackbar taking its place. Cross-surface combos explain
   *          which replace action interrupted which prior undo window.
   * Measurements: none.
   * Privacy: no document contents.
   */
  'home.replaceUndo.snackbarReplaced',

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
   * Fired by: `JsonTreeComponent.applyManualHighlight`
   *           (`shared/components/json-tree/json-tree.component.ts`)
   * Props: { kind: 'single' | 'cascade'; bucket: ColorBucket;
   *   replacedExisting: 'true' | 'false';
   *   inputMode: 'keyboard' | 'mouse' }.
   *
   * `inputMode` is the user gesture that activated the apply
   * (issue #100): `'keyboard'` for any non-pointer activation
   * (Enter/Space inside the flyout after arrow-key navigation,
   * Enter/Space on the parent menu-item that applies the preferred
   * color, and assistive-tech virtual-cursor activation that
   * synthesizes clicks without a pointer); `'mouse'` for any
   * pointer-device activation (mouse click, touch tap, pen tap).
   * The classification feeds focus restoration too: keyboard
   * activation returns DOM focus to the originating row, mouse
   * activation does not.
   */
  'tree.highlight.apply',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.removeManualHighlight` and
   *           `JsonTreeComponent.removeManualTreeHighlight`
   *           (`shared/components/json-tree/json-tree.component.ts`)
   * Props: { kind: 'single' | 'cascade';
   *   removedFromAncestor: 'true' | 'false' }.
   */
  'tree.highlight.remove',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.onSwatchMenuOpened`
   *           (`shared/components/json-tree/json-tree.component.ts`)
   * Props: { kind: 'single' | 'cascade' }.
   */
  'tree.highlight.swatchOpened',

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
   * Props: { escaped: boolean }. `true` when Alt was held during the
   * menu-item click; emits the JSON-string-literal variant of the
   * value (DESIGN_SPEC.md §443).
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
   * Fired by: `JsonTreeComponent.findByKey`
   *           (`shared/components/json-tree/json-tree.component.ts`)
   * Props: none
   */
  'tree.contextMenu.searchByKey',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.findByValue`
   *           (`shared/components/json-tree/json-tree.component.ts`)
   * Props: none
   */
  'tree.contextMenu.searchByValue',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.collapseFromHere`
   *           (`shared/components/json-tree/json-tree.component.ts`).
   *           Wired to both the surfaced top-level shortcut row (the
   *           bolded "Collapse from here" item rendered for expanded
   *           containers) and the in-Subtree submenu's "Collapse"
   *           item; the `source` prop disambiguates which path the
   *           user took. Per Path Y the action itself is a single
   *           non-recursive `treeControl.collapse(node)` regardless
   *           of which entry point fires it.
   * Props: { source: 'top' | 'submenu' }. `'top'` for the surfaced
   * shortcut row, `'submenu'` for the in-Subtree item. Lets analytics
   * see whether the surfaced default-shortcut affordance pays off
   * relative to the duplicated in-submenu copy.
   */
  'tree.contextMenu.collapse',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.expandAllFromHere`
   *           (`shared/components/json-tree/json-tree.component.ts`).
   *           v0.23.0+: single entry point -- the new top-level
   *           `Expand all from here` row in the row/kebab menu.
   *           The deep `Subtree > Expand > All` leaf and the
   *           in-Subtree `expandAll` elevation were both retired
   *           in v0.23.0. Gated on `showExpandAllFromHere(node) &&
   *           hasContainerDescendants(node)` so primitives-only
   *           containers (where `expandAll` produces the same end
   *           state as the bolded `Expand 1 level` surfaced
   *           shortcut) fall through to the surfaced row alone.
   * Props: { source: 'topRow' }. Always `'topRow'` post-v0.23.0
   * (the only callable enum value; if a future change re-elevates
   * `expandAll` from another location it must add a new enum value
   * here with documentation).
   *
   * **Sink:** `traces` (via `logger.info()`) until issue #241
   * migrates `tree.*` events to `customEvents`.
   *
   * **Note for KQL authors:** unlike sibling events
   * `tree.contextMenu.collapse` and `tree.contextMenu.expandToDepth`
   * which use `source: 'top'` for their bolded surfaced shortcut
   * callers, this event uses `source: 'topRow'` because the new
   * top-level item is **non-bolded**. A naive cross-event filter
   * `where customDimensions.source == 'top'` will silently miss
   * the expandAll signal. Use `where customDimensions.source in
   * ('top', 'topRow')` for unioned queries.
   */
  'tree.contextMenu.expandAllFromHere',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.expandToDepthFromHere`
   *           (`shared/components/json-tree/json-tree.component.ts`).
   *           Wired to the surfaced top-level "Expand 1 level"
   *           shortcut row (which routes here with `relativeDepth: 1`
   *           and `source: 'top'`) AND to the in-Subtree submenu's
   *           per-depth items (`+1, +2, ..., +9`). The in-Subtree
   *           range extended from `+1..+5` to `+1..+9` in v0.23.0
   *           to mirror the toolbar's `Expand to Level` dropdown.
   * Props: { relativeDepth: number, source: 'top' | 'submenu' }.
   * `relativeDepth` is the N in "expand N levels from here";
   * post-v0.23.0 it ranges over `1..9` for `source === 'submenu'`
   * and is always `1` for `source === 'top'`. Lets us see which
   * depths users invoke most often.
   *
   * **Workbook caveat:** any time-bucketed query that filters
   * `relativeDepth in (1,2,3,4,5)` will silently drop the new
   * `6..9` values introduced in v0.23.0. Widen any such filter
   * to `relativeDepth in (1,2,3,4,5,6,7,8,9)` or drop the IN
   * filter entirely.
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
   * Fired by: `(menuOpened)` listener on the `Subtree >` submenu
   *           trigger inside the row context menu
   *           (`shared/components/json-tree/json-tree.component.html`).
   *           Phase 4 of the tree-menu overhaul: tells us whether
   *           users are discovering the new Subtree submenu (Path Y)
   *           or sticking with the surfaced top-level shortcut.
   * Props: none. The trigger renders only when at least one
   *        subtree-affecting predicate is true; counts-only is
   *        sufficient to answer the discoverability question.
   * Volume control: bounded-frequency (one open per user gesture).
   */
  'tree.contextMenu.subtreeOpened',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.applyManualHighlight` (`cascade`
   *           false branch) reached from the top-level row menu's
   *           single-row "Highlight" item
   *           (`shared/components/json-tree/json-tree.component.ts`).
   *           Phase 4: distinguishes single-row highlight scope
   *           from subtree scope so analytics can show which is
   *           more common.
   * Props: none. `tree.highlight.apply` already carries the color
   *        bucket; this event is a counts-only marker for the
   *        per-row scope's invocation count.
   */
  'tree.contextMenu.highlight',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.applyManualHighlight` (`cascade`
   *           true branch) reached from the in-Subtree submenu's
   *           "Highlight" item
   *           (`shared/components/json-tree/json-tree.component.ts`).
   *           Pairs with `tree.contextMenu.highlight`.
   * Props: none.
   */
  'tree.contextMenu.highlightSubtree',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.onExtractMenuClick`
   *           (`shared/components/json-tree/json-tree.component.ts`)
   *           when the conditional "Extract embedded JSON" item is
   *           triggered from the row context menu. The same row
   *           also exposes Extract via the inline pill button which
   *           emits its own `tree.extract.click` event with
   *           `source: 'rowButton'`; this menu-driven path is
   *           tracked separately so we can see whether users prefer
   *           the inline pill or the menu item.
   * Props: none. `tree.extract.apply` already carries size / kind
   *        buckets when the extraction succeeds.
   */
  'tree.contextMenu.extract',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.onSortKeysMenuClick`
   *           (`shared/components/json-tree/json-tree.component.ts`)
   *           when the user clicks the right-click menu item.
   * Volume control: bounded-frequency. Bounded by user clicks.
   *   Distinct from the success event so unsuccessful clicks are still
   *   counted.
   * Props: none.
   * Privacy: no path, no key names.
   */
  'tree.contextMenu.sortKeys',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.copyValue` (`source === 'dblclick'`
   *           branch) (`shared/components/json-tree/json-tree.component.ts`).
   *           See also `tree.contextMenu.copyValue` for the
   *           menu-driven entry point; both share copy semantics.
   * Props: { escaped: boolean }. `true` when Alt was held during the
   * row double-click; emits the JSON-string-literal variant of the
   * value (DESIGN_SPEC.md §443).
   *
   * Since issue #109, this event fires for primitive (leaf) rows
   * AND for empty containers (`{}` / `[]`). The tree-menu overhaul
   * (plan.md decision Q4b) relaxed issue #109's "expand/collapse
   * instead of copying" wording for the empty-container edge case
   * where there is no expand/collapse to do -- dblclick on an empty
   * container now copies the literal `{}` or `[]`. Container rows
   * with children (`type === 'object' | 'array'` and
   * `children.length > 0`) still emit `tree.row.doubleClickToggle`
   * instead of this event.
   */
  'tree.row.doubleClickCopyValue',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.onRowDblClick` container branch
   *           (`shared/components/json-tree/json-tree.component.ts`).
   *           Issue #109 split dblclick semantics: container rows
   *           toggle their expansion state instead of copying.
   * Props: { action: 'expand' | 'collapse' }. The post-toggle state
   * (i.e., what the row became after the double-click), so analytics
   * directly answer "how often did dblclick expand vs collapse".
   * Volume control: bounded-frequency (one user double-click per
   * emit). No path or content data. Empty containers do not emit
   * this event -- they fall through to `tree.row.doubleClickCopyValue`
   * since the tree-menu overhaul relaxed issue #109's wording for
   * containers with no children. The chevron-button toggle path
   * remains uninstrumented for parity with pre-issue-#109 behavior.
   */
  'tree.row.doubleClickToggle',

  /**
   * Severity: info
   * Fired by: `JsonTreeComponent.copyValue` (`source === 'keyboard'`
   *           branch), invoked from `onTreeKeydown`'s Ctrl+C / Cmd+C
   *           case (`shared/components/json-tree/json-tree.component.ts`).
   *           See also `tree.contextMenu.copyValue` and
   *           `tree.row.doubleClickCopyValue`; all three share copy
   *           semantics (raw text for primitives, pretty JSON for
   *           containers; toast on success/failure).
   * Props: { escaped: boolean }. Always `false` on this path -- the
   * Ctrl+C / Cmd+C shortcut intentionally does not honor Alt for the
   * JSON-string-literal escape variant. The prop is kept for shape
   * parity with the other two copy events so analytics queries that
   * group across all copy entry points stay uniform.
   * Volume control: bounded-frequency (one user keypress per emit).
   * Fires for any focused tree row -- leaf, container with children,
   * or empty container ({} / []) alike. No path or content data.
   */
  'tree.keyboard.copyValue',

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
  'tree.breadcrumb.copyPath',

  // Beacons (icon-bearing rules surfaced via toolbar pills + ancestor badges)

  /**
   * Kind: event
   * Fired by: `JsonTreeComponent`'s `beaconIndex` computed signal
   *           via an `effect` that observes recompute results
   *           (`shared/components/json-tree/json-tree.component.ts`).
   *           Fires at most once per recompute. Skipped when the
   *           index is identity-equal to `EMPTY_BEACON_INDEX`.
   * Props: none.
   * Measurements: { iconCount: number; totalMatches: number }.
   *   - `iconCount` is the number of distinct icon-types with at
   *     least one match in the current tree.
   *   - `totalMatches` is the sum of matches across all icon-types
   *     (a node that matches two icons counts twice). Both are
   *     small bounded counts (icons are a 7-value closed enum;
   *     totalMatches is bounded by tree node count, already gated
   *     by upstream tree-build limits).
   */
  'beacons.evaluated',

  /**
   * Kind: event
   * Fired by: `JsonTreeComponent.onAncestorBadgeClick`
   *           (`shared/components/json-tree/json-tree.component.ts`)
   *           when a user clicks an ancestor-badge on a collapsed
   *           tree row to expand the path to a hidden beacon match.
   * Props: { icon: FormattingIcon }. Closed enum (7 values: warning,
   *   check, star, info, error, flag, bookmark).
   * Measurements: { descendantCount: number }. Number of beacon
   *   matches under this ancestor for this icon-type. No paths,
   *   no key/value strings.
   */
  'beacons.badge.clicked',

  /**
   * Kind: event
   * Fired by: `ToolbarBeaconPillsComponent.onPillClick`
   *           (`shared/components/toolbar-beacon-pills/`) when the
   *           user clicks a beacon pill to cycle through matches in
   *           that bucket.
   * Props: { icon: FormattingIcon; direction: 'forward' | 'backward' }.
   *   `direction` is `'backward'` when the user holds Shift while
   *   clicking; otherwise `'forward'`.
   * Measurements: { bucketSize: number }. Number of matches in this
   *   icon's bucket at click time. No paths, no key/value strings.
   */
  'beacons.pill.clicked',

  /**
   * Kind: event
   * Fired by: `HomeComponent`'s `BeaconNavigationService.jumpRequest$`
   *           subscription (`features/home/home.component.ts`) once
   *           per dispatched jump.
   * Props: { target: 'tree' | 'editor';
   *          paneVisibility: 'editor-only' | 'tree-only' | 'both';
   *          source: 'pill' | 'badge';
   *          icon: FormattingIcon }.
   *   All closed enums. `target` is the pane that handled the jump;
   *   `paneVisibility` is the *effective* layout state that drove
   *   dispatch (post-M7l narrow-viewport override; equal to the
   *   persisted state on wide viewports);
   *   `source` distinguishes pill clicks from ancestor-badge clicks;
   *   `icon` identifies the bucket. No paths, no key/value strings.
   */
  'beacons.crossPane.dispatched',
] as const;

export type TelemetryMessageId = (typeof TELEMETRY_MESSAGE_IDS)[number];
