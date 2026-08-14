const DEFAULT_ATTEMPTS = 5;

export async function fetchJson<T>(url: string, attemptLimit = DEFAULT_ATTEMPTS): Promise<T> {
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= attemptLimit; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        lastError = `HTTP ${response.status} while requesting ${url}`;

        if (response.status === 429 || response.status === 503) {
          const retryAfter = response.headers.get('retry-after');
          await delay(parseRetryAfter(retryAfter) ?? 1000 * attempt);
        } else if (attempt < attemptLimit) {
          await delay(500 * attempt);
        }

        continue;
      }

      return (await response.json()) as T;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await delay(500 * attempt);
    }
  }

  throw new Error(lastError ?? `Unknown HTTP error while requesting ${url}`);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, 10_000);
  }

  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.min(Math.max(date - Date.now(), 0), 10_000);
  }

  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
