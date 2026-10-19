import { AccessPushTransport } from '@spinajs/authz';
import type { AccessChangedEvent, Principal, PrincipalRef } from '@spinajs/authz';
import { AuthnEventSink } from '@spinajs/authn/contracts';
import type { AuthnEvent } from '@spinajs/authn/contracts';
import { Response as HttpResponse } from '@spinajs/http';
import type * as express from 'express';
/** Below the 30 s idle timeout of common proxies. */
export declare const SSE_HEARTBEAT_MS = 25000;
export declare const SSE_RETRY_MS = 5000;
/** One open stream: `owner` is the principal's own key, which the cap and session ends go by. */
interface EventStream {
    readonly res: express.Response;
    readonly keys: readonly string[];
    readonly owner: string;
    /** AuthnFacts.sessionHandle of the principal, when a session signed it in. */
    readonly session?: string;
    readonly heartbeat: ReturnType<typeof setInterval>;
}
export declare function sseFrame(event: AccessChangedEvent): string;
/** The principal keys a stream hears: the principal's and those of the identities that speak with it. */
export declare function pushKeys(principal: Principal): string[];
/** Server-sent `authz.changed` events for clients without the socket (design §10.4); `@spinajs/http` has no SSE. */
export declare class SseAccessPushTransport extends AccessPushTransport {
    readonly name = "sse";
    /** Tests shorten it; read when a stream opens. */
    heartbeatMs: number;
    protected MaxStreamsPerPrincipal: number;
    protected readonly streams: Map<string, Set<express.Response<any, Record<string, any>>>>;
    /** By owner key, oldest first. */
    protected readonly owned: Map<string, EventStream[]>;
    protected listening: boolean;
    open(req: express.Request, res: express.Response, principal: Principal): void;
    push(principals: readonly string[] | '*', event: AccessChangedEvent): Promise<void>;
    /** Open streams of one principal key, or all of them. */
    count(principal?: string): number;
    closeAll(): void;
    /**
     * Ends the session streams of `identity` that `session` names or the SessionIssuer no longer lists. The re-check also
     * catches a stream whose handle went stale while it was open: a rotation or role switch re-keys the session row and
     * publishes no event, so the logout names a handle the stream never saw.
     */
    sessionEnded(identity: PrincipalRef, session?: string): Promise<void>;
    protected sessionStreams(identity: PrincipalRef): EventStream[];
    protected end(stream: EventStream): void;
    protected forget(stream: EventStream): void;
    protected targets(principals: readonly string[] | '*'): Set<express.Response>;
    /** Stops listening for the server shutdown and closes the open streams. */
    dispose(): Promise<void>;
    protected listenForShutdown(): void;
    private readonly onServerClosing;
}
/** What `GET /user/access/events` returns: it hands the express response to the transport and sends no body itself. */
export declare class AccessEventStream extends HttpResponse {
    protected readonly transport: SseAccessPushTransport;
    protected readonly principal: Principal;
    constructor(transport: SseAccessPushTransport, principal: Principal);
    execute(req: express.Request, res: express.Response): Promise<void>;
}
/** Ends a session's event streams when authn reports the session's end (logout, revoke, impersonation start and end). */
export declare class SseSessionEndSink extends AuthnEventSink {
    protected Transport: SseAccessPushTransport;
    publish(e: AuthnEvent): Promise<void>;
}
export {};
//# sourceMappingURL=sse.d.ts.map