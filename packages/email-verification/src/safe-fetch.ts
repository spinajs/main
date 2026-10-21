import { Injectable } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';

export interface SafeFetchOptions {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly headers?: Record<string, string>;
}

export interface FetchedText {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

export class ResponseTooLarge extends Error {
  public readonly name = 'ResponseTooLarge';
}

/** GET over https only: no redirect is followed, and the body is cut off at `maxBytes`. */
@Injectable()
export class SafeFetch {
  public async get(url: string, options: SafeFetchOptions): Promise<FetchedText> {
    if (new URL(url).protocol !== 'https:') {
      throw new InvalidArgument('only https URLs are fetched');
    }
    const res = await fetch(url, { method: 'GET', redirect: 'manual', headers: options.headers, signal: AbortSignal.timeout(options.timeoutMs) });
    return { status: res.status, headers: res.headers, body: await readCapped(res, options.maxBytes) };
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new ResponseTooLarge(`response is larger than ${maxBytes} bytes`);
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}
