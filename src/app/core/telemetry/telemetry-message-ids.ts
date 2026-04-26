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
  'history.recordPaste.failed',

  // Blobs
  'blobs.copyLink.failed',

  // Auth
  'msal.error'
] as const;

export type TelemetryMessageId = (typeof TELEMETRY_MESSAGE_IDS)[number];
