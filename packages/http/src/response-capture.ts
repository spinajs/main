import type express from 'express';

export interface CapturedJsonReply {
  status: number;
  /** Lower-case names; only those a replay restores: REPLAYED_HEADERS and the route's own IResponseOptions.Headers. */
  headers: Record<string, string>;
  /** The JSON text sent, or null for an empty body. */
  body: string | null;
}

/** Sees each JSON reply of one response; attached by whoever replays replies (the idempotency gate). */
export abstract class ResponseCapture {
  public abstract capture(reply: CapturedJsonReply): void;
}

export const REPLAYED_HEADERS = ['content-type', 'location', 'etag'] as const;

const CAPTURE = Symbol('responseCapture');

export function attachResponseCapture(res: express.Response, capture: ResponseCapture): void {
  (res.locals as Record<symbol, ResponseCapture>)[CAPTURE] = capture;
}

export function responseCaptureOf(res: express.Response): ResponseCapture | undefined {
  return (res.locals as Record<symbol, ResponseCapture | undefined> | undefined)?.[CAPTURE];
}

const HOOK_HEADERS = Symbol('hookHeaders');

/** Header names an onAfter hook added for this one request: a replay must not restore them. */
export function excludeFromCapture(res: express.Response, names: Iterable<string>): void {
  const locals = res.locals as Record<symbol, Set<string> | undefined>;
  const excluded = (locals[HOOK_HEADERS] ??= new Set());
  for (const name of names) excluded.add(name.toLowerCase());
}

/** Rebuilt with the app's json settings, so a replay sends the bytes express sent: res.json exposes no body to read back. */
function jsonText(res: express.Response, model: unknown): string | null {
  const app = res.app as express.Application | undefined;
  const text = JSON.stringify(model, app?.get('json replacer'), app?.get('json spaces')) as string | undefined;
  if (text === undefined) {
    return null;
  }
  return app?.get('json escape') ? text.replace(/[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) : text;
}

// A replay must not hand out the first answer's cookies; the rest describe the connection or the bytes of one
// sending, which the replay's own send sets again.
const NEVER_CAPTURED = new Set(['set-cookie', 'connection', 'keep-alive', 'transfer-encoding', 'trailer', 'upgrade', 'content-length', 'date']);

/**
 * Read after res.json(), when the status and headers are final. `routeHeaders` are the names the route set through
 * IResponseOptions.Headers; names an onAfter hook added are left out.
 */
export function capturedJsonReply(res: express.Response, model: unknown, routeHeaders: readonly string[] = []): CapturedJsonReply {
  const headers: Record<string, string> = {};
  const fromHooks = (res.locals as Record<symbol, Set<string> | undefined> | undefined)?.[HOOK_HEADERS];
  for (const name of new Set([...REPLAYED_HEADERS, ...routeHeaders.map((n) => n.toLowerCase())])) {
    const value = res.getHeader(name);
    if (value !== undefined && !NEVER_CAPTURED.has(name) && !fromHooks?.has(name)) {
      headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
    }
  }
  return { status: res.statusCode, headers, body: model === undefined || model === null ? null : jsonText(res, model) };
}
