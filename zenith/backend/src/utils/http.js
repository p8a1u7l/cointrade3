import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE']);

function isRetryableError(error) {
  if (!error) return false;
  if (error.name === 'AbortError') {
    return true;
  }
  if (typeof error.code === 'string' && RETRYABLE_ERROR_CODES.has(error.code)) {
    return true;
  }
  return false;
}

export async function fetchWithRetry(url, options = {}) {
  const {
    timeoutMs = 10_000,
    retries = 0,
    retryDelayMs = 250,
    retryOn = DEFAULT_RETRYABLE_STATUS,
    fetchImpl = fetch,
    ...fetchOptions
  } = options;

  if (typeof fetchImpl !== 'function') {
    throw new Error('A valid fetch implementation must be provided');
  }

  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...fetchOptions, signal: controller.signal });
      if (attempt < retries && retryOn instanceof Set && retryOn.has(response.status)) {
        await delay(retryDelayMs * 2 ** attempt);
        attempt += 1;
        continue;
      }
      return response;
    } catch (error) {
      if (attempt >= retries || !isRetryableError(error)) {
        throw error;
      }
      await delay(retryDelayMs * 2 ** attempt);
      attempt += 1;
    } finally {
      clearTimeout(timeout);
    }
  }
}
