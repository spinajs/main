var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Autoinject, DI, Injectable, Singleton } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { AUTHZ_CHANGED_EVENT, AccessPushTransport, principalKey } from '@spinajs/authz';
import { AuthnEventSink, SessionIssuer } from '@spinajs/authn/contracts';
import { Response as HttpResponse } from '@spinajs/http';
/** Below the 30 s idle timeout of common proxies. */
export const SSE_HEARTBEAT_MS = 25_000;
export const SSE_RETRY_MS = 5_000;
export function sseFrame(event) {
    return `event: ${AUTHZ_CHANGED_EVENT}\ndata: ${JSON.stringify(event)}\n\n`;
}
/** The principal keys a stream hears: the principal's and those of the identities that speak with it. */
export function pushKeys(principal) {
    return [...new Set([principal, ...(principal.companions ?? [])].map((p) => principalKey(p)))];
}
/** Server-sent `authz.changed` events for clients without the socket (design §10.4); `@spinajs/http` has no SSE. */
let SseAccessPushTransport = class SseAccessPushTransport extends AccessPushTransport {
    constructor() {
        super(...arguments);
        this.name = 'sse';
        /** Tests shorten it; read when a stream opens. */
        this.heartbeatMs = SSE_HEARTBEAT_MS;
        this.streams = new Map();
        /** By owner key, oldest first. */
        this.owned = new Map();
        this.listening = false;
        this.onServerClosing = () => this.closeAll();
    }
    open(req, res, principal) {
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
        const max = Math.max(1, this.MaxStreamsPerPrincipal);
        const open = this.owned.get(owner) ?? [];
        for (const oldest of open.slice(0, Math.max(0, open.length - max + 1)))
            this.end(oldest);
        const heartbeat = setInterval(() => !res.writableEnded && res.write(': heartbeat\n\n'), this.heartbeatMs);
        heartbeat.unref();
        const session = principal.authn?.sessionHandle;
        const stream = { res, keys: pushKeys(principal), owner, heartbeat, ...(session ? { session } : {}) };
        for (const key of stream.keys) {
            let set = this.streams.get(key);
            if (!set)
                this.streams.set(key, (set = new Set()));
            set.add(res);
        }
        this.owned.set(owner, [...(this.owned.get(owner) ?? []), stream]);
        // res, not req: res 'close' also fires when we end the stream ourselves
        res.once('close', () => this.forget(stream));
    }
    async push(principals, event) {
        const frame = sseFrame(event);
        for (const res of this.targets(principals)) {
            if (!res.writableEnded)
                res.write(frame);
        }
    }
    /** Open streams of one principal key, or all of them. */
    count(principal) {
        return principal === undefined ? this.targets('*').size : this.streams.get(principal)?.size ?? 0;
    }
    closeAll() {
        for (const res of this.targets('*')) {
            // Otherwise the kept-alive connection holds server.close() for the keep-alive timeout.
            const socket = res.socket;
            res.end(() => socket?.end());
        }
    }
    /**
     * Ends the session streams of `identity` that `session` names or the SessionIssuer no longer lists. The re-check also
     * catches a stream whose handle went stale while it was open: a rotation or role switch re-keys the session row and
     * publishes no event, so the logout names a handle the stream never saw.
     */
    async sessionEnded(identity, session) {
        if (session !== undefined)
            for (const s of this.sessionStreams(identity))
                if (s.session === session)
                    this.end(s);
        const rest = this.sessionStreams(identity);
        // Per call: authz boot builds this transport, sse in use or not, and must not build the issuer's session provider then.
        if (rest.length === 0)
            return;
        const issuer = (await DI.RootContainer.resolveOptional(SessionIssuer));
        if (!issuer)
            return;
        const live = new Set((await issuer.list({ type: identity.type, id: identity.id })).map((r) => r.handle));
        for (const s of rest)
            if (!live.has(s.session))
                this.end(s);
    }
    sessionStreams(identity) {
        return (this.owned.get(principalKey(identity)) ?? []).filter((s) => s.session !== undefined);
    }
    end(stream) {
        this.forget(stream);
        stream.res.end();
    }
    forget(stream) {
        clearInterval(stream.heartbeat);
        for (const key of stream.keys) {
            const set = this.streams.get(key);
            set?.delete(stream.res);
            if (set?.size === 0)
                this.streams.delete(key);
        }
        const rest = (this.owned.get(stream.owner) ?? []).filter((s) => s !== stream);
        if (rest.length === 0)
            this.owned.delete(stream.owner);
        else
            this.owned.set(stream.owner, rest);
    }
    targets(principals) {
        const sets = principals === '*' ? [...this.streams.values()] : principals.map((k) => this.streams.get(k) ?? new Set());
        return new Set(sets.flatMap((s) => [...s]));
    }
    /** Stops listening for the server shutdown and closes the open streams. */
    async dispose() {
        DI.removeListener('http.server.closing', this.onServerClosing);
        this.listening = false;
        this.closeAll();
    }
    // An open stream would hold server.close() until the shutdown watchdog fires.
    listenForShutdown() {
        if (this.listening)
            return;
        this.listening = true;
        DI.on('http.server.closing', this.onServerClosing);
    }
};
__decorate([
    Config('authz.http.events.maxStreamsPerPrincipal'),
    __metadata("design:type", Number)
], SseAccessPushTransport.prototype, "MaxStreamsPerPrincipal", void 0);
SseAccessPushTransport = __decorate([
    Singleton(),
    Injectable(AccessPushTransport)
], SseAccessPushTransport);
export { SseAccessPushTransport };
/** What `GET /user/access/events` returns: it hands the express response to the transport and sends no body itself. */
export class AccessEventStream extends HttpResponse {
    constructor(transport, principal) {
        super(null);
        this.transport = transport;
        this.principal = principal;
    }
    async execute(req, res) {
        this.transport.open(req, res, this.principal);
    }
}
const SESSION_ENDS = new Set(['logout', 'session.revoke', 'session.expire']);
/**
 * Their `session` is not always the ended one (stop names the impersonator's new session, start the
 * impersonation's), so the identity's and the actor's streams are only re-checked against the SessionIssuer.
 */
const IMPERSONATION = new Set(['impersonation.start', 'impersonation.end', 'impersonation.expire']);
/** Ends a session's event streams when authn reports the session's end (logout, revoke, impersonation start and end). */
let SseSessionEndSink = class SseSessionEndSink extends AuthnEventSink {
    async publish(e) {
        const ends = SESSION_ENDS.has(e.type);
        if (e.outcome !== 'success' || !e.identity || (!ends && !IMPERSONATION.has(e.type)))
            return;
        const transport = this.Transport;
        if (ends)
            await transport.sessionEnded(e.identity, e.session);
        else
            await Promise.all([e.identity, ...(e.actor ? [e.actor] : [])].map((who) => transport.sessionEnded(who)));
    }
};
__decorate([
    Autoinject(SseAccessPushTransport),
    __metadata("design:type", SseAccessPushTransport)
], SseSessionEndSink.prototype, "Transport", void 0);
SseSessionEndSink = __decorate([
    Injectable(AuthnEventSink)
], SseSessionEndSink);
export { SseSessionEndSink };
//# sourceMappingURL=sse.js.map