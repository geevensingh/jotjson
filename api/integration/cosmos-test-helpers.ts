/**
 * Helpers shared by the api-integration test harness (#63).
 *
 * `withRetry` wraps Cosmos control-plane operations (create container,
 * drop container, list containers) with bounded exponential backoff
 * because the real Cosmos service can return transient 429/5xx during
 * provisioning bursts.
 *
 * Important: control-plane operations retry. **Data-plane CRUD** (the
 * actual code under test) deliberately does NOT retry through this
 * helper - we want production-code bugs to surface, not be absorbed
 * by test-side retries.
 */

export interface WithRetryOptions {
  /** Number of attempts INCLUDING the first call. Default 3. */
  readonly attempts?: number;
  /** Initial backoff in milliseconds. Doubled on each retry. Default 500. */
  readonly backoffMs?: number;
  /** Optional label used in error messages. */
  readonly label?: string;
}

/**
 * Returns the result of `op()`, retrying on any thrown error up to
 * `options.attempts - 1` times with exponential backoff. Throws the
 * last error if all attempts fail.
 */
export async function withRetry<T>(
  op: () => Promise<T>,
  options: WithRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseBackoff = options.backoffMs ?? 500;
  const label = options.label ?? 'cosmos control-plane operation';

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await op();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delay = baseBackoff * Math.pow(2, attempt - 1);
      console.warn(
        `[integration] ${label} failed on attempt ${attempt}/${attempts}; retrying in ${delay}ms`,
        error instanceof Error ? error.message : error,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError instanceof Error
    ? new Error(`${label} failed after ${attempts} attempts: ${lastError.message}`)
    : new Error(`${label} failed after ${attempts} attempts`);
}

export const TEST_CONTAINER_PREFIX = 'blobs-';
export const ORPHAN_THRESHOLD_MS = 24 * 60 * 60 * 1000;
export const CONTAINER_COUNT_HARD_CAP = 20;
