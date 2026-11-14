/**
 * What a key replays. http: `{ kind: 'http', body: { status, headers, body } }`; socket: `{ kind: 'socket', body: IdempotentReply }`;
 * queue: `{ kind: 'ack', body: null }`.
 */
export interface StoredReply {
  kind: string;
  body: unknown;
}

export type IdempotencyClaim =
  | { state: 'claimed'; token: string }
  | { state: 'running'; leaseUntil: number; fingerprint?: string }
  | { state: 'done'; reply: StoredReply; fingerprint?: string };

/** A key that a caller holds or completed. */
export type IdempotencyHeld = Exclude<IdempotencyClaim, { state: 'claimed' }>;

export interface IdempotencyClaimOptions {
  fingerprint?: string;
  leaseMs: number;
  now: number;
  /** Stored for operators only: the key is already a hash of it. */
  namespace?: string;
}

export interface IdempotencyScope {
  namespace: string;
  principal?: string;
}

export interface IdempotencyRunOptions<T> {
  fingerprint?: string;
  ttl: string | number;
  lease?: string | number;
  /** undefined = do not store, release the key. */
  toReply(value: T): StoredReply | undefined;
  fromReply(reply: StoredReply): T;
}

export type IdempotencyOutcome<T> = { replayed: false; value: T } | { replayed: true; value: T };

export interface IIdempotencyConfig {
  store: string;
  lease: string | number;
  sweepBatch: number;
  sweepEvery: string;
}
