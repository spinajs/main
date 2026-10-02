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
