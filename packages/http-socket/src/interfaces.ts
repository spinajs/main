import type { IncomingHttpHeaders, Server as HttpNodeServer } from 'http';
import type { Server as HttpsNodeServer } from 'https';
import { principalKey } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import type { IPolicyGroup, IResolvedRoutePolicies } from '@spinajs/http';
import type { Decision, IAuthnPrincipalStorage } from '@spinajs/authz';
import type { SocketConnection } from './connection.js';
import type { BaseSocketController } from './controller.js';
import { SocketException } from '@spinajs/http-socket-common';
import type { CommandRequest } from '@spinajs/http-socket-common';
import { AuthenticationFailed } from '@spinajs/exceptions';
import type { TokenBucket } from './limits.js';

export interface ISocketRateConfig {
  perSecond: number;
  burst: number;
}

export interface ISocketIdempotencyConfig {
  /** DI name of the IdempotencyStore implementation (W3). */
  service: string;
  ttlMs: number;
}

export interface ISocketCorsConfig {
  /** Exact origins allowed to open a socket besides same-origin pages; no wildcards. Empty: none ( authz-v3 A31 ). */
  origins: string[];
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
  maxInFlightPerConnection: number;
  rate: ISocketRateConfig;
  idempotency: ISocketIdempotencyConfig;
  drainMs: number;
  /** `ordered` commands: how long an aborted command whose handler is still running keeps its queue place */
  ordering: { abortGraceMs: number };
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
  /** W3: replay by `(clientId, idempotencyKey)` */
  idempotent?: boolean;
  /** serial queue per connection, or per clientId across reconnects */
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
 * `AuthzService.current()` reads ( F4 `IAuthzAsyncStorage`, as http's `req.storage.Principal` );
 * `AuthnPrincipal` is authn's hand-off key: the principal when a source resolved it, else null.
 */
export interface ISocketCallStorage extends IAuthnPrincipalStorage {
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
  inFlight: number;
  /** running commands by request id, for cancel / disconnect / shutdown */
  readonly running: Map<string, ISocketCommandContext>;
  /** settles when the connect hooks are done; commands wait for it */
  ready: Promise<void>;
  /** ms epoch of the last warn about a dropped event */
  eventWarnedAt?: number;
}

export interface ISocketCommandContext extends ISocketCallContext {
  readonly kind: 'command';
  readonly request: CommandRequest;
  readonly runtime: IConnectionRuntime;
  readonly receivedAt: number;
  /** set by the arguments stage */
  args?: unknown[];
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

/** Spec §5.2 order. 350 is W1's principal re-check ( Task 10A, D16 ); 500 is reserved for W3's idempotency stage. */
export const STAGE_ORDER = {
  Size: 100,
  Rate: 200,
  InFlight: 300,
  Authentication: 350,
  Lookup: 400,
  Idempotency: 500,
  Policies: 600,
  Arguments: 700,
  Ordering: 800,
} as const;
