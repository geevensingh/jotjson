/**
 * Centralized telemetry message IDs.
 *
 * Every call to `LoggerService.info/warn/error` MUST use one of these
 * tokens. They are intentionally English, stable across locales, and
 * typed as a literal-union so typos fail at compile time and we don't
 * fragment telemetry across slight variants of the same id.
 *
 * Each token has a JSDoc block documenting:
 * - **Severity**: `info` | `warn` | `error`. Drives which `console.*`
 *   mirror is used and which Application Insights sink is hit
 *   (`trackTrace` for info/warn, `trackException` for error).
 * - **Fired by**: the call site(s). Some tokens have multiple call
 *   sites; all are listed.
 * - **Props**: the shape attached to `LoggerService.X(token, props)`.
 *   `none` means the call passes no props.
 * - **Exception**: error-only. The error object passed as the `cause`
 *   argument to `logger.error(token, cause, props?)`, which is
 *   normalized via `normalizeError` into `trackException` telemetry.
 *
 * When adding a new token, add a JSDoc block above it documenting
 * severity, call site, and props (see `AGENTS.md` -> Logging).
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
   * Severity: warn
   * Fired by: `HomeComponent.onToggleVisibility`
   *           (`features/home/home.component.ts`)
   * Props: none
   */
  'share.visibility.failed',

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
