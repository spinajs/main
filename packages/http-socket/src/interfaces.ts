import type { IncomingHttpHeaders, Server as HttpNodeServer } from 'http';
import type { Server as HttpsNodeServer } from 'https';
import { principalKey } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';

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
  /** How often a live connection's principal is re-checked with its source; 0 turns it off. */
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
  /** socket.io adapter constructor for several instances; unset = in memory */
  adapter?: unknown;
}

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

  /** Re-checks a live connection ( expiry, revocation ): by default the handshake must still authenticate as the same principal. */
  public async revalidate(handshake: ISocketHandshake, principal: Principal): Promise<boolean> {
    try {
      const again = await this.authenticate(handshake);
      return again !== null && principalKey(again) === principalKey(principal);
    } catch {
      return false;
    }
  }
}

/** Kept in `socket.data.auth`, which connection state recovery restores after a short drop. */
export interface ISocketAuthState {
  principal: Principal;
  /** name of the source that resolved the principal; null for UNATTENDED */
  source: string | null;
  /** ms epoch of the last successful check */
  checkedAt: number;
}

/** Supplies the node http(s) server socket.io attaches to. */
export abstract class SocketHttpHost {
  public abstract server(): Promise<HttpNodeServer | HttpsNodeServer>;
}
