export const BOT_HTTP_MAX_BODY_BYTES = 64 * 1024;

export type BotHttpFailure = 'not_https' | 'network' | 'timeout' | 'redirect' | 'status' | 'not_json' | 'too_large';

/** A provider call that produced no usable answer; `failure` is safe to log, the request form is never part of it. */
export class BotHttpError extends Error {
  constructor(public readonly failure: BotHttpFailure, public readonly status?: number) {
    super(`bot verifier http call failed: ${failure}${status === undefined ? '' : ` (HTTP ${status})`}`);
    this.name = 'BotHttpError';
  }
}

/**
 * POSTs `form` and returns the parsed JSON answer. https only, no redirects followed, a timeout, a 2xx answer with a
 * JSON content type and at most BOT_HTTP_MAX_BODY_BYTES; anything else throws BotHttpError.
 */
export async function postFormForJson(url: string, form: Readonly<Record<string, string>>, timeoutMs: number): Promise<unknown> {
  if (new URL(url).protocol !== 'https:') {
    throw new BotHttpError('not_https');
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new BotHttpError(isTimeout(err) ? 'timeout' : 'network');
  }

  // fetch answers an opaque redirect with status 0 for redirect: 'manual'.
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel();
    throw new BotHttpError('redirect', response.status);
  }
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel();
    throw new BotHttpError('status', response.status);
  }
  if (!/^application\/([a-z0-9.+-]+\+)?json\s*(;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw new BotHttpError('not_json', response.status);
  }

  const text = await readCapped(response);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BotHttpError('not_json', response.status);
  }
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BOT_HTTP_MAX_BODY_BYTES) {
        await reader.cancel();
        throw new BotHttpError('too_large', response.status);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof BotHttpError) throw err;
    throw new BotHttpError(isTimeout(err) ? 'timeout' : 'network', response.status);
  }
  return Buffer.concat(chunks).toString('utf8');
}
