/**
 * Ambient declarations for the W3C Web App Manifest "Launch Handler" API
 * (Chromium 102+). The PWA `file_handlers` + `launch_handler` manifest
 * members route OS file-association launches (right-click -> Open With ->
 * JotJSON, or `start data.json` from a terminal) into the running app via
 * `window.launchQueue`. The API is not yet in `lib.dom.d.ts` (TS 5.x), so
 * the surface is declared here as the single source of truth, avoiding
 * inline `Window` casts in service / component code (skeptic F7).
 *
 * Spec: https://wicg.github.io/web-app-launch/
 * Chromium impl: https://developer.chrome.com/docs/web-platform/launch-handler
 *
 * Only present in Chromium when the app is installed as a PWA. Firefox,
 * Safari, and non-installed Chromium all leave `window.launchQueue`
 * undefined; the controller checks for that before calling `setConsumer`.
 */

interface LaunchParams {
  readonly files: readonly FileSystemFileHandle[];
  readonly targetURL: string;
}

interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void | Promise<void>): void;
}

interface Window {
  readonly launchQueue?: LaunchQueue;
}
