/**
 * Jest `setupFiles` module for the api-integration test config.
 *
 * Runs once per worker BEFORE production code is imported. Remaps
 * `COSMOS_CI_*` env vars to the production env-var names IF the
 * production names aren't already set. This allows two activation
 * paths:
 *
 *   - **CI** sets the production env vars directly via the workflow's
 *     `env:` block (deterministic, runs identically in workers and
 *     globalSetup/globalTeardown). The remap below is a no-op because
 *     COSMOS_ENDPOINT is already populated.
 *   - **Local dev** sets `COSMOS_CI_*` (matches the secret naming).
 *     This file remaps them to the production names that
 *     `getCosmos()` reads.
 *
 * Runs in the test worker (NOT globalSetup), so the env vars are set
 * before any `import` statement evaluates production code.
 */

function remapIfUnset(productionVar: string, ciVar: string): void {
  if (process.env[productionVar] === undefined && process.env[ciVar] !== undefined) {
    process.env[productionVar] = process.env[ciVar];
  }
}

remapIfUnset('COSMOS_ENDPOINT', 'COSMOS_CI_ENDPOINT');
remapIfUnset('COSMOS_KEY', 'COSMOS_CI_KEY');
