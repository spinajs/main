import { DI, Injectable, Singleton } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { AUTHZ_CHANGED_EVENT, AccessPushTransport, principalKey } from '@spinajs/authz';
import type { AccessChangedEvent, Principal, PrincipalRef } from '@spinajs/authz';
import { AuthnEventSink, SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnEvent, AuthnEventType } from '@spinajs/authn/contracts';
import { Response as HttpResponse } from '@spinajs/http';
import type * as express from 'express';

/** Below the 30 s idle timeout of common proxies. */
export const SSE_HEARTBEAT_MS = 25_000;

export const SSE_RETRY_MS = 5_000;

export const SSE_MAX_STREAMS_PER_PRINCIPAL = 5;

/** One open stream: `owner` is the principal's own key, which the cap and session ends go by. */
interface EventStream {
  readonly res: express.Response;
  readonly keys: readonly string[];
  readonly owner: string;
  /** AuthnFacts.sessionHandle of the principal, when a session signed it in. */
  readonly session?: string;
  readonly heartbeat: ReturnType<typeof setInterval>;
}

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

  @Config('authz.http.events.maxStreamsPerPrincipal', { defaultValue: SSE_MAX_STREAMS_PER_PRINCIPAL })
  protected MaxStreamsPerPrincipal: number;

  protected readonly streams = new Map<string, Set<express.Response>>();

  /** By owner key, oldest first. */
  protected readonly owned = new Map<string, EventStream[]>();

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

    const owner = principalKey(principal);
    const max = Math.max(1, this.MaxStreamsPerPrincipal ?? SSE_MAX_STREAMS_PER_PRINCIPAL);
    const open = this.owned.get(owner) ?? [];
    for (const oldest of open.slice(0, Math.max(0, open.length - max + 1))) this.end(oldest);

    const heartbeat = setInterval(() => !res.writableEnded && res.write(': heartbeat\n\n'), this.heartbeatMs);
    heartbeat.unref();
    const session = principal.authn?.sessionHandle;
    const stream: EventStream = { res, keys: pushKeys(principal), owner, heartbeat, ...(session ? { session } : {}) };

    for (const key of stream.keys) {
      let set = this.streams.get(key);
      if (!set) this.streams.set(key, (set = new Set()));
      set.add(res);
    }
    this.owned.set(owner, [...(this.owned.get(owner) ?? []), stream]);

    // res, not req: res 'close' also fires when we end the stream ourselves
    res.once('close', () => this.forget(stream));
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

  /**
   * Ends the streams `identity` opened with the session `session`. Without one (a revoke of several sessions), the
   * identity's session streams are checked against the SessionIssuer's list and those it no longer lists end.
   */
  public async sessionEnded(identity: PrincipalRef, session?: string): Promise<void> {
    const streams = (this.owned.get(principalKey(identity)) ?? []).filter((s) => s.session !== undefined);
    if (streams.length === 0) return;
    if (session !== undefined) {
      for (const s of streams) if (s.session === session) this.end(s);
      return;
    }
    if (!DI.check(SessionIssuer)) return;
    const live = new Set((await ((await DI.resolve(SessionIssuer)) as SessionIssuer).list({ type: identity.type, id: identity.id })).map((r) => r.handle));
    for (const s of streams) if (!live.has(s.session!)) this.end(s);
  }

  protected end(stream: EventStream): void {
    this.forget(stream);
    stream.res.end();
  }

  protected forget(stream: EventStream): void {
    clearInterval(stream.heartbeat);
    for (const key of stream.keys) {
      const set = this.streams.get(key);
      set?.delete(stream.res);
      if (set?.size === 0) this.streams.delete(key);
    }
    const rest = (this.owned.get(stream.owner) ?? []).filter((s) => s !== stream);
    if (rest.length === 0) this.owned.delete(stream.owner);
    else this.owned.set(stream.owner, rest);
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

const SESSION_ENDS: ReadonlySet<AuthnEventType> = new Set<AuthnEventType>(['logout', 'session.revoke', 'session.expire', 'impersonation.end', 'impersonation.expire']);

/** Ends a session's event streams when authn reports the session's end (logout, revoke, impersonation end). */
@Injectable(AuthnEventSink)
export class SseSessionEndSink extends AuthnEventSink {
  public async publish(e: AuthnEvent): Promise<void> {
    if (e.outcome !== 'success' || !e.identity || !SESSION_ENDS.has(e.type)) return;
    const transport = (await DI.resolve(SseAccessPushTransport)) as SseAccessPushTransport;
    await transport.sessionEnded(e.identity, e.session);
  }
}
