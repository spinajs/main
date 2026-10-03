import type { SocketError } from '@spinajs/http-socket-common';

/** A durable command waiting for its reply. */
export interface OutboxEntry<P = unknown> {
  /** Queue position: assigned by the store, strictly increasing, never reused. */
  readonly seq: number;
  readonly name: string;
  readonly payload: P;
  /** Idempotency key chosen by the app; `${clientId}:${seq}` when absent. */
  readonly key?: string;
  /** ms epoch */
  readonly createdAt: number;
}

/** An entry the server refused for good; it stays until the app clears it. */
export interface FailedOutboxEntry<P = unknown> extends OutboxEntry<P> {
  readonly error: SocketError;
  /** ms epoch */
  readonly failedAt: number;
}

export interface OutboxInput<P = unknown> {
  name: string;
  payload: P;
  key?: string;
}

/**
 * Where durable commands wait for their reply. Every method resolves only once its change is durable
 * in the store's medium: the queue sends a command after `add` resolved. One SocketClient at a time per store.
 */
export interface OutboxStore {
  add<P>(input: OutboxInput<P>): Promise<OutboxEntry<P>>;
  /** Entries not yet acknowledged, ascending `seq`. */
  pending(): Promise<OutboxEntry[]>;
  /** Removes an acknowledged entry; an unknown seq is ignored. */
  remove(seq: number): Promise<void>;
  /** Moves the pending entry `entry.seq` to the failed list as `entry`; ignored when that seq is not pending. */
  fail(entry: FailedOutboxEntry): Promise<void>;
  /** The failed list, ascending `seq`: export it before clearing it. */
  failed(): Promise<FailedOutboxEntry[]>;
  /** Removes failed entries; all of them when `seqs` is omitted. */
  clearFailed(seqs?: readonly number[]): Promise<void>;
}

/** Keeps nothing across reloads: the default when no store is given. */
export class MemoryOutboxStore implements OutboxStore {
  private seq = 0;
  private readonly entries = new Map<number, OutboxEntry>();
  private readonly failures = new Map<number, FailedOutboxEntry>();

  public async add<P>(input: OutboxInput<P>): Promise<OutboxEntry<P>> {
    const entry: OutboxEntry<P> = { seq: ++this.seq, name: input.name, payload: input.payload, createdAt: Date.now(), ...(input.key !== undefined ? { key: input.key } : {}) };
    this.entries.set(entry.seq, entry);
    return entry;
  }

  public async pending(): Promise<OutboxEntry[]> {
    return [...this.entries.values()];
  }

  public async remove(seq: number): Promise<void> {
    this.entries.delete(seq);
  }

  public async fail(entry: FailedOutboxEntry): Promise<void> {
    if (this.entries.delete(entry.seq)) {
      this.failures.set(entry.seq, entry);
    }
  }

  public async failed(): Promise<FailedOutboxEntry[]> {
    return [...this.failures.values()].sort((a, b) => a.seq - b.seq);
  }

  public async clearFailed(seqs?: readonly number[]): Promise<void> {
    if (seqs === undefined) {
      this.failures.clear();
      return;
    }

    for (const seq of seqs) {
      this.failures.delete(seq);
    }
  }
}
