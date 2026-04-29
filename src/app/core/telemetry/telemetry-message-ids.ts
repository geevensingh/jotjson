/**
 * Centralized telemetry message IDs.
 *
 * Every call to `LoggerService.info/warn/error` MUST use one of these
 * tokens. They are intentionally English, stable across locales, and
 * typed as a literal-union so typos fail at compile time and we don't
 * fragment telemetry across slight variants of the same id.
 */
export const TELEMETRY_MESSAGE_IDS = [
  // Generic
  'app.unhandled',
  'boot.failed',

  // HTTP / API
  'api.error',

  // Service worker / updates
  'update.activate.failed',
  'update.unrecoverable',

  // Editor
  'monaco.loadFailed',

  // Home / share
  'home.save.failed',
  'home.upload.tooLarge',
  'home.upload.readFailed',
  'home.upload.binary',
  'share.visibility.failed',
  'share.delete.failed',

  // Blobs
  'blobs.load.failed',

  // History
  'history.load.failed',
  'history.loadMore.failed',
  'history.clear.failed',
  'history.delete.failed',
  'history.open.failed',

  // Blobs
  'blobs.copyLink.failed',

  // Auth
  'msal.error',

  // Formatting rule sets (M6g-1)
  'ruleSets.created',
  'ruleSets.updated',
  'ruleSets.deleted',
  'ruleSets.applied',

  // Tree row context menu (M7q)
  'tree.contextMenu.opened',
  'tree.contextMenu.copyKey',
  'tree.contextMenu.copyValue',
  'tree.contextMenu.copyPath',
  'tree.contextMenu.searchByKey',
  'tree.contextMenu.searchByValue',
  'tree.contextMenu.collapse',
  'tree.contextMenu.expandAllFromHere',
  'tree.contextMenu.expandToDepth',
  'tree.row.doubleClickCopyValue'
] as const;

export type TelemetryMessageId = (typeof TELEMETRY_MESSAGE_IDS)[number];
