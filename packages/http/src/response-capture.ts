import type express from 'express';

export interface CapturedJsonReply {
  status: number;
  /** Lower-case names; only those a replay restores. */
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

/** Rebuilt with the app's json settings, so a replay sends the bytes express sent: res.json exposes no body to read back. */
function jsonText(res: express.Response, model: unknown): string | null {
  const app = res.app as express.Application | undefined;
  const text = JSON.stringify(model, app?.get('json replacer'), app?.get('json spaces')) as string | undefined;
  if (text === undefined) {
    return null;
  }
  return app?.get('json escape') ? text.replace(/[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) : text;
}

/** Read after res.json(), when the status and headers are final. */
export function capturedJsonReply(res: express.Response, model: unknown): CapturedJsonReply {
  const headers: Record<string, string> = {};
  for (const name of REPLAYED_HEADERS) {
    const value = res.getHeader(name);
    if (value !== undefined) {
      headers[name] = String(value);
    }
  }
  return { status: res.statusCode, headers, body: model === undefined || model === null ? null : jsonText(res, model) };
}
