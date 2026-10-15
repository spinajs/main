import { DI, Injectable, Singleton } from '@spinajs/di';
import { AUTHZ_CHANGED_EVENT, AccessPushTransport, principalKey } from '@spinajs/authz';
import type { AccessChangedEvent, Principal } from '@spinajs/authz';
import { Response as HttpResponse } from '@spinajs/http';
import type * as express from 'express';

/** Below the 30 s idle timeout of common proxies. */
export const SSE_HEARTBEAT_MS = 25_000;

export const SSE_RETRY_MS = 5_000;

export function sseFrame(event: AccessChangedEvent): string {
  return `event: ${AUTHZ_CHANGED_EVENT}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** The principal keys a stream hears: the principal's and those of the identities that speak with it. */
export function pushKeys(principal: Principal): string[] {
  return [...new Set([principal, ...(principal.companions ?? [])].map((p) => principalKey(p)))];
}

/** Server-sent `authz.changed` events for clients without the socket (design §10.4); `@spinajs/http` has no SSE. */
@Singleton()
@Injectable(AccessPushTransport)
export class SseAccessPushTransport extends AccessPushTransport {
  public readonly name = 'sse';

  /** Tests shorten it; read when a stream opens. */
  public heartbeatMs = SSE_HEARTBEAT_MS;

  protected readonly streams = new Map<string, Set<express.Response>>();

  protected listening = false;

  public open(req: express.Request, res: express.Response, principal: Principal): void {
    this.listenForShutdown();

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    // no-transform: the compression middleware skips the response instead of buffering its frames
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    req.socket.setNoDelay(true);
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);

    const keys = pushKeys(principal);
    for (const key of keys) {
      let set = this.streams.get(key);
      if (!set) this.streams.set(key, (set = new Set()));
      set.add(res);
    }

    const heartbeat = setInterval(() => !res.writableEnded && res.write(': heartbeat\n\n'), this.heartbeatMs);
    heartbeat.unref();

    // res, not req: res 'close' also fires when we end the stream ourselves
    res.once('close', () => {
      clearInterval(heartbeat);
      for (const key of keys) {
        const set = this.streams.get(key);
        set?.delete(res);
        if (set?.size === 0) this.streams.delete(key);
      }
    });
  }

  public async push(principals: readonly string[] | '*', event: AccessChangedEvent): Promise<void> {
    const frame = sseFrame(event);
    for (const res of this.targets(principals)) {
      if (!res.writableEnded) res.write(frame);
    }
  }

  /** Open streams of one principal key, or all of them. */
  public count(principal?: string): number {
    return principal === undefined ? this.targets('*').size : this.streams.get(principal)?.size ?? 0;
  }

  public closeAll(): void {
    for (const res of this.targets('*')) {
      // Otherwise the kept-alive connection holds server.close() for the keep-alive timeout.
      const socket = res.socket;
      res.end(() => socket?.end());
    }
  }

  protected targets(principals: readonly string[] | '*'): Set<express.Response> {
    const sets = principals === '*' ? [...this.streams.values()] : principals.map((k) => this.streams.get(k) ?? new Set<express.Response>());
    return new Set(sets.flatMap((s) => [...s]));
  }

  // An open stream would hold server.close() until the shutdown watchdog fires.
  protected listenForShutdown(): void {
    if (this.listening) return;
    this.listening = true;
    DI.on('http.server.closing', () => this.closeAll());
  }
}

/** What `GET /user/access/events` returns: it hands the express response to the transport and sends no body itself. */
export class AccessEventStream extends HttpResponse {
  constructor(protected readonly transport: SseAccessPushTransport, protected readonly principal: Principal) {
    super(null);
  }

  public async execute(req: express.Request, res: express.Response): Promise<void> {
    this.transport.open(req, res, this.principal);
  }
}
