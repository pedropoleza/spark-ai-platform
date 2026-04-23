/**
 * Retry com exponential backoff + jitter. Usado principalmente em chamadas GHL
 * críticas (free-slots, book_appointment) onde falha transitória é comum.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2;
  const baseDelay = opts.baseDelayMs ?? 150;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) break;
      const jitter = Math.random() * 0.3 + 0.85; // 0.85-1.15x
      const delay = Math.round(baseDelay * Math.pow(2, attempt) * jitter);
      if (opts.label) {
        console.warn(`[retry:${opts.label}] attempt ${attempt + 1}/${maxRetries + 1} failed: ${error instanceof Error ? error.message : String(error)}. Retrying in ${delay}ms`);
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}
