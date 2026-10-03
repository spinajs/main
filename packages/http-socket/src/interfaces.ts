import type { IncomingHttpHeaders, Server as HttpNodeServer } from 'http';
import type { Server as HttpsNodeServer } from 'https';
import { principalKey } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import type { IPolicyGroup, IResolvedRoutePolicies } from '@spinajs/http';
import type { Decision, IAuthnPrincipalStorage, IAuthzAsyncStorage } from '@spinajs/authz';
import type { SocketConnection } from './connection.js';
import type { BaseSocketController } from './controller.js';
import { SocketException } from '@spinajs/http-socket-common';
import type { CommandRequest, SocketError } from '@spinajs/http-socket-common';
import { AuthenticationFailed } from '@spinajs/exceptions';
import type { TokenBucket } from './limits.js';

export interface ISocketRateConfig {
  perSecond: number;
  burst: number;
}

export interface ISocketIdempotencyConfig {
  /** Class name of the IdempotencyStore implementation; this whole object is its first constructor argument. */
  service: string;
  /** How long a completed key replays its reply. */
  ttlMs: number;
  /** MemoryIdempotencyStore: completed keys kept at most; the least recently used go first. */
  maxEntries: number;
}

export interface ISocketCorsConfig {
  /** Exact origins allowed to open a socket besides same-origin pages; no wildcards. Empty: none ( authz-v3 A31 ). */
  origins: string[];
}

export interface ISocketStreamsConfig {
  /** largest credit window a client may grant one stream; a larger request or grant fails it with invalid_argument. Also the unsent packets on a connection above which its streams pause */
  maxCredits: number;
  /** streams open on one connection at once; they hold no command in-flight slot */
  maxPerConnection: number;
  /** a stream left without credit, or with its connection backlogged, this long fails with deadline_exceeded */
  stallTimeoutMs: number;
}

export interface ISocketAuthConfig {
  /** Refuse a handshake no SocketPrincipalSource resolves, instead of running it as UNATTENDED. */
  required: boolean;
  /** How often a live connection's principal is re-checked with its source, idle or not; 0 turns it off ( `ceiling.expiresAt` is still enforced ). */
  revalidateMs: number;
}

/** `http.socket` */
export interface ISocketServerConfig {
  path: string;
  cors: ISocketCorsConfig;
  auth: ISocketAuthConfig;
  pingInterval: number;
  pingTimeout: number;
  recovery: { maxDisconnectionMs: number };
  maxPayloadBytes: number;
  /** commands running on one connection at once */
  maxInFlightPerConnection: number;
  /** events running or waiting on one connection at once, apart from the command slots; at least rate.burst */
  maxInFlightEventsPerConnection: number;
  rate: ISocketRateConfig;
  idempotency: ISocketIdempotencyConfig;
  drainMs: number;
  /** `ordered` commands: how long an aborted command whose handler is still running keeps its queue place */
  ordering: { abortGraceMs: number };
  /**
   * A connect hook still running after `connectTimeoutMs` is logged, and the connection's commands and events stop
   * waiting for it. The connection then proceeds as if the hooks were done, so a disconnect hook may run while the
   * timed-out connect hook is still running.
   */
  hooks: { connectTimeoutMs: number };
  /** stream replies ( W4 ) */
  streams: ISocketStreamsConfig;
  /** socket.io adapter constructor for several instances; unset = in memory */
  adapter?: unknown;
  /**
   * engine.io transports. Prefer `['websocket']` when a principal source reads cookies: a browser
   * always sends an Origin on a WebSocket upgrade, while polling requests are plain HTTP.
   */
  transports: SocketTransport[];
}

export type SocketTransport = 'websocket' | 'polling';

/** What a `SocketPrincipalSource` sees of the socket.io handshake. */
export interface ISocketHandshake {
  /** `io(url, { auth })`: protocol, clientId, token and any app fields */
  readonly auth: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<IncomingHttpHeaders>;
  /** Unsigned raw cookie values; signed-cookie checks belong to the source. */
  readonly cookies: Readonly<Record<string, string>>;
  /** the socket's remote address; never taken from X-Forwarded-For */
  readonly address: string;
  readonly url: string;
  readonly query: Readonly<Record<string, unknown>>;
  readonly secure: boolean;
  readonly issuedAt: number;
}

/** How a `SocketPrincipalSource` judged a live connection's principal. */
export type SocketRevalidationStatus = 'valid' | 'invalid' | 'unavailable';

/**
 * `true` / `false` mean 'valid' / 'invalid' ( the pre-tri-state contract ). A 'valid' answer may carry
 * the principal as the source sees it now ( eg. a rotated token's later `ceiling.expiresAt` ); the
 * connection adopts it when it has the same `principalKey`, and is refused when it has not.
 */
export type SocketRevalidationResult = SocketRevalidationStatus | boolean | { readonly status: 'valid'; readonly principal: Principal };

/**
 * Resolves the authz-v3 principal of a connection from its handshake: the socket form of
 * authz-http's `PrincipalSource`, whose `authenticate(req)` needs an express request that
 * authn-http's middleware has already seen. Sources run in ascending `order` and the first
 * non-null principal wins. Return null when the handshake carries none of your credentials;
 * throw ( eg. `Unauthenticated` ) to refuse the connection.
 */
export abstract class SocketPrincipalSource {
  public abstract readonly name: string;

  public abstract readonly order: number;

  public abstract authenticate(handshake: ISocketHandshake): Promise<Principal | null>;

  /**
   * Re-checks a live connection every `http.socket.auth.revalidateMs` ( expiry, revocation ). By
   * default the handshake must still authenticate as the same principal.
   *
   * - 'invalid' ( or `false` ): the connection is refused with `unauthenticated` and closed at once.
   *   Return it for a definitive refusal ( disabled account, revoked credential ).
   * - 'unavailable', a throw or a timeout: the source could not decide ( eg. its store is down ); a throw
   *   is read as 'unavailable', never as a refusal. The connection
   *   keeps running for ONE more `revalidateMs` grace window and is asked again; when that answer is
   *   not 'valid' either, it is refused and closed. Commands are served during the grace window.
   */
  public async revalidate(handshake: ISocketHandshake, principal: Principal): Promise<SocketRevalidationResult> {
    let again: Principal | null;
    try {
      again = await this.authenticate(handshake);
    } catch (err) {
      // a throttled refusal ( retryAfterMs ) says "not now", not "no"
      const refused = err instanceof AuthenticationFailed || (err instanceof SocketException && err.code === 'unauthenticated' && err.retryAfterMs === undefined);
      return refused ? 'invalid' : 'unavailable';
    }

    return again !== null && principalKey(again) === principalKey(principal) ? { status: 'valid', principal: again } : 'invalid';
  }
}

/**
 * What the handshake checked, kept in `socket.data.client`. Connection state recovery restores it and
 * skips the handshake middleware, so a recovered connection reads these, never its new `auth`.
 */
export interface ISocketClientState {
  clientId: string;
  protocol: number;
}

/** Kept in `socket.data.auth`, which connection state recovery restores after a short drop. */
export interface ISocketAuthState {
  principal: Principal;
  /** name of the source that resolved the principal; null for UNATTENDED */
  source: string | null;
  /** ms epoch of the last successful check */
  checkedAt: number;
  /** ms epoch of an 'unavailable' answer not yet followed by a 'valid' one: the connection is in its grace window */
  unavailableSince?: number;
}

/** Supplies the node http(s) server socket.io attaches to. */
export abstract class SocketHttpHost {
  public abstract server(): Promise<HttpNodeServer | HttpsNodeServer>;
}

export const SOCKET_CONTROLLER_DESCRIPTOR = Symbol('SOCKET_CONTROLLER_DESCRIPTOR');

export type SocketHandlerKind = 'unknown' | 'command' | 'event' | 'connect' | 'disconnect';

export interface ICommandOptions {
  /** ajv schema for the payload; wins over the `@Payload` schema and the DTO's `@Schema` */
  schema?: object;
  /** server-side deadline; the earlier of this and the client's `deadline` applies */
  timeoutMs?: number;
  /** replay by principal, clientId and idempotencyKey; a durable command also needs ordered: 'client' */
  idempotent?: boolean;
  /** serial queue per connection, or per principal and clientId across reconnects; a stream handler cannot be ordered */
  ordered?: 'connection' | 'client';
}

export interface IEventOptions {
  schema?: object;
}

export interface ISocketParameter {
  Index: number;
  /** extractor resolved from DI */
  Type: Class<SocketArg>;
  /** design:paramtypes entry */
  RuntimeType: unknown;
  Schema: object | null;
  Options?: unknown;
}

export interface ISocketHandlerDescriptor {
  /** 'unknown' until a handler decorator runs; registration refuses it */
  Kind: SocketHandlerKind;
  Method: string | symbol;
  /** name without the controller prefix */
  Name: string;
  Options: ICommandOptions;
  Parameters: Map<number, ISocketParameter>;
  /** one group per @SocketPolicy call: AND inside a group, OR across groups */
  Policies: IPolicyGroup[];
}

export interface ISocketControllerDescriptor {
  Prefix: string | null;
  Policies: IPolicyGroup[];
  Handlers: Map<string | symbol, ISocketHandlerDescriptor>;
}

export interface IRegisteredHandler {
  /** prefix + '.' + name */
  readonly fullName: string;
  readonly controller: BaseSocketController;
  readonly descriptor: ISocketHandlerDescriptor;
  readonly policies: IResolvedRoutePolicies;
}

/**
 * The AsyncLocalStorage store of one call ( D14 ). `Principal` is the key authz-v3's
 * `AuthzService.current()` and `runAs` read ( F4 `IAuthzAsyncStorage`, as http's `req.storage.Principal` );
 * `AuthnPrincipal` is authn's hand-off key: the principal when a source resolved it, else null.
 */
export interface ISocketCallStorage extends IAuthnPrincipalStorage, IAuthzAsyncStorage {
  Principal: Principal;
  /** written by SocketAccessPolicy, as authz-http's AccessPolicy writes req.storage.AuthzDecision */
  AuthzDecision?: Decision;
  [key: string]: unknown;
}

/** What argument extractors, policies and hooks see of one call. */
export interface ISocketCallContext {
  readonly kind: SocketHandlerKind;
  readonly connection: SocketConnection;
  handler?: IRegisteredHandler;
  readonly payload: unknown;
  readonly signal: AbortSignal;
  /** disconnect reason, for @OnDisconnect hooks */
  readonly reason?: string;
  /** ambient AsyncLocalStorage store of the call */
  readonly storage: ISocketCallStorage;
}

/** Extracts one handler argument. Implementations are resolved from DI by class. */
export abstract class SocketArg {
  public abstract extract(ctx: ISocketCallContext, param: ISocketParameter): Promise<unknown>;
}

/** Per-connection pipeline state. */
export interface IConnectionRuntime {
  readonly connection: SocketConnection;
  readonly bucket: TokenBucket;
  /** commands past the in-flight stage */
  inFlight: number;
  /** events counted against maxInFlightEventsPerConnection, from arrival until their handler settles */
  eventsInFlight: number;
  /** stream replies open on this connection, from the stream reply until their end or fail frame */
  streams: number;
  /** running commands by request id, for cancel / disconnect / shutdown */
  readonly running: Map<string, ISocketCommandContext>;
  /** settles, never rejects, when the connect hooks are done or `hooks.connectTimeoutMs` has passed */
  ready: Promise<void>;
  /** ms epoch of the last warn about a dropped event or command frame */
  warnedAt?: number;
}

export interface ISocketCommandContext extends ISocketCallContext {
  readonly kind: 'command';
  readonly request: CommandRequest;
  readonly runtime: IConnectionRuntime;
  readonly receivedAt: number;
  /** set by the arguments stage */
  args?: unknown[];
  /** the refusal of the rate token the dispatcher took when the frame arrived; the rate stage throws it */
  rateRefusal?: unknown;
  /** set by the idempotency stage when it runs the command under a key; the ordering stage settles it inside the queue place */
  idempotency?: ISocketIdempotencyClaim;
  /** fires `signal`; the dispatcher replies with `reason` at once */
  abort(reason: SocketException): void;
  /** keeps the earliest of all armed deadlines, counted from `receivedAt` */
  armDeadline(ms: number | undefined): void;
}

/**
 * One step of the command pipeline. Stages run in ascending `Order` as an onion: call `next()` to
 * continue, return without calling it to answer early ( eg. an idempotent replay ), throw to fail.
 * Register with `@Injectable(SocketCommandStage)`.
 */
export abstract class SocketCommandStage {
  public abstract get Order(): number;

  public abstract execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown>;
}

/**
 * Spec §5.2 order. 320 waits for the connect hooks; 350 is W1's principal re-check ( Task 10A, D16 ); 500 is W3's idempotency stage.
 * Ordering ( 550 ) comes before policies and arguments, so they see the state the command's predecessors left: a durable edit
 * pipelined behind its create would otherwise be hydrated before the create ran, and its not_found stored as final.
 */
export const STAGE_ORDER = {
  Size: 100,
  Rate: 200,
  InFlight: 300,
  Ready: 320,
  Authentication: 350,
  Lookup: 400,
  Idempotency: 500,
  Ordering: 550,
  Policies: 600,
  Arguments: 700,
} as const;

/** What an idempotent command replays: its result, or the error it failed with for good. */
export type IdempotentReply = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: SocketError };

/** A command's outcome as the pipeline saw it. */
export type CommandOutcome = { readonly result: unknown } | { readonly error: unknown };

/** The idempotency stage's hold on one key while its command runs. */
export interface ISocketIdempotencyClaim {
  /**
   * Records the outcome once: a result or a final error is stored, a retryable or unauthenticated error or the call's own
   * abort releases the key. Later calls get the first answer. Null: released, or detached.
   * A result is answered in its wire ( JSON ) form, and still answered when the store cannot keep it.
   */
  settle(outcome: CommandOutcome): Promise<IdempotentReply | null>;
  /** The pipeline gave up on a handler that still runs: the key stays running until `running` settles, and `settle` answers null. */
  detach(running: Promise<unknown>): void;
}
