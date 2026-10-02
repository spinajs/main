import type { HttpRequest, HttpResponse } from '../harness/index.js';

export interface SetCookie {
  readonly name: string;
  readonly value: string;
  /** Names lower-case; flags are `true`. */
  readonly attributes: Readonly<Record<string, string | true>>;
}

export function parseSetCookie(raw: readonly string[]): readonly SetCookie[] {
  return raw.map((line) => {
    const [pair, ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    const attributes: Record<string, string | true> = {};
    for (const a of attrs) {
      const i = a.indexOf('=');
      if (i < 0) {
        attributes[a.trim().toLowerCase()] = true;
      } else {
        attributes[a.slice(0, i).trim().toLowerCase()] = a.slice(i + 1).trim();
      }
    }
    return { name: pair.slice(0, eq < 0 ? undefined : eq).trim(), value: eq < 0 ? '' : pair.slice(eq + 1).trim(), attributes };
  });
}

export function isCleared(c: SetCookie, now: Date): boolean {
  if (c.value === '') return true;
  const maxAge = c.attributes['max-age'];
  if (typeof maxAge === 'string' && Number(maxAge) <= 0) return true;
  const expires = c.attributes.expires;
  return typeof expires === 'string' && new Date(expires).getTime() <= now.getTime();
}

/** Ignores domain, path and secure: one app, one origin. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  apply(req: HttpRequest): HttpRequest {
    return { ...req, cookies: { ...Object.fromEntries(this.cookies), ...req.cookies } };
  }

  store(res: HttpResponse): HttpResponse {
    const now = new Date();
    for (const c of parseSetCookie(res.setCookie)) {
      if (isCleared(c, now)) {
        this.cookies.delete(c.name);
      } else {
        this.cookies.set(c.name, c.value);
      }
    }
    return res;
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  clear(): void {
    this.cookies.clear();
  }
}
