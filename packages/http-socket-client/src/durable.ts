import { MAX_ID_LENGTH, MAX_KEY_LENGTH, SocketException, WIRE_EVENTS, isId, isKey, isSocketError, type CommandReply, type CommandRequest, type SocketError } from '@spinajs/http-socket-common';
import type { CommandDispatcher } from './commands.js';
import type { Connection, ConnectionState } from './connection.js';
import { Emitter, rethrowAsync } from './emitter.js';
import { randomId } from './ids.js';
import type { FailedOutboxEntry, OutboxEntry, OutboxStore } from './outbox.js';
import { ReconnectPolicy, type ReconnectOptions } from './reconnect.js';
import { assertTimeoutMs } from './timeout.js';

export interface DurableOptions {
  /** Durable commands sent and not yet answered at once. */
  window?: number;
  /** A command unanswered this long on a live connection is sent again; the server replays or joins it. */
  ackTimeoutMs?: number;
}

export interface DurableCommandOptions {
  /**
   * Idempotency key, eg. an op id: 1-MAX_KEY_LENGTH printable ASCII characters, not starting with `${clientId}:`.
   * When omitted, `${clientId}:${random nonce}` is generated and persisted with the entry.
   */
  key?: string;
}

export const DEFAULT_DURABLE: Readonly<Required<DurableOptions>> = Object.freeze({ window: 16, ackTimeoutMs: 60_000 });

export interface AckedCommand {
  entry: OutboxEntry;
  result: unknown;
}

export interface FailedCommand {
  entry: FailedOutboxEntry;
  error: SocketError;
}

export interface DurableEvents {
  acked: (event: AckedCommand) => void;
  failed: (event: FailedCommand) => void;
}

export interface DurableQueueOptions {
  connection: Connection;
  commands: CommandDispatcher;
  store: OutboxStore;
  clientId: string;
  reconnect?: Partial<ReconnectOptions>;
  durable?: DurableOptions;
  /** Gets listener errors, and store failures that no submit() call can reject with. */
  onListenerError?: (error: unknown) => void;
}

const CLOSED: SocketError = { code: 'unavailable', message: 'the client is closed; the command stays in the outbox', retryable: false };
const STREAM_REPLY: SocketError = { code: 'failed_precondition', message: 'a durable command cannot reply with a stream', retryable: false };
const MALFORMED_REPLY: SocketError = { code: 'internal', message: 'malformed reply', retryable: false };

type Timer = ReturnType<typeof setTimeout>;
type Outcome = { ok: true; result: unknown } | { ok: false; failed: FailedOutboxEntry };

interface Item {
  readonly entry: OutboxEntry;
  readonly key: string;
  state: 'queued' | 'sent' | 'done';
  /** the request whose reply counts; null while queued */
  requestId: string | null;
  timer: Timer | undefined;
  outcome?: Outcome;
  resolve?: (result: unknown) => void;
  reject?: (error: unknown) => void;
}

/**
 * Durable commands ( spec §6 ): persisted before they are sent, sent in order up to a window, sent
 * again after any drop, and settled in send order. The server runs each key once and runs a command
 * only after the one named in its `after`, so a resend never runs twice and never overtakes.
 */
export class DurableQueue {
  public readonly events: Emitter<DurableEvents>;
  private readonly items: Item[] = [];
  private readonly policy: ReconnectPolicy;
  private readonly window: number;
  private readonly ackTimeoutMs: number;
  private readonly onStoreError: (error: unknown) => void;
  private readonly unsubscribe: () => void;
  /** generated keys start with it; app keys must not */
  private readonly keyPrefix: string;
  private readonly loaded: Promise<void>;
  private adding: Promise<unknown> = Promise.resolve();
  private attempt = 0;
  private pausedUntil = 0;
  private pauseTimer: Timer | undefined;
  private closed = false;

  constructor(private readonly options: DurableQueueOptions) {
    const { window, ackTimeoutMs } = { ...DEFAULT_DURABLE, ...options.durable };
    if (!(Number.isInteger(window) && window >= 1)) {
      throw new RangeError(`durable.window must be an integer of at least 1, got ${window}`);
    }

    // `${clientId}:${seq}` must stay a key the server accepts
    if (!isId(options.clientId)) {
      throw new RangeError(`clientId must be 1-${MAX_ID_LENGTH} printable ASCII characters`);
    }

    this.keyPrefix = `${options.clientId}:`;
    this.window = window;
    this.ackTimeoutMs = assertTimeoutMs('durable.ackTimeoutMs', ackTimeoutMs);
    this.policy = new ReconnectPolicy(options.reconnect);
    this.onStoreError = options.onListenerError ?? rethrowAsync;
    this.events = new Emitter<DurableEvents>(options.onListenerError);
    this.unsubscribe = options.connection.events.on('state', (state, previous) => this.onState(state, previous));
    this.loaded = this.load();
    this.loaded.catch(this.onStoreError);
  }

  /** Commands not yet settled to their callers, resumed ones included. */
  public get size(): number {
    return this.items.length;
  }

  public submit(name: string, payload: unknown, options: DurableCommandOptions = {}): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(SocketException.fromWire(CLOSED));
    }

    if (options.key !== undefined && (!isKey(options.key) || options.key.startsWith(this.keyPrefix))) {
      return Promise.reject(new RangeError(`a durable command key must be 1-${MAX_KEY_LENGTH} printable ASCII characters and must not start with '${this.keyPrefix}'`));
    }

    let resolve!: (result: unknown) => void;
    let reject!: (error: unknown) => void;
    const settled = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    // one add at a time, and the item joins the queue inside that turn: items stay in seq order
    const queued = this.adding.then(async () => {
      await this.loaded;
      // not the seq: a store that starts over ( wiped, or in memory ) reuses seqs, and the server would
      // replay an old command's stored reply to a new one
      const entry = await this.options.store.add({ name, payload, key: options.key ?? `${this.keyPrefix}${randomId()}` });
      // persisted already: it resumes on the next start
      if (this.closed) {
        throw SocketException.fromWire(CLOSED);
      }

      const item = this.item(entry);
      item.resolve = resolve;
      item.reject = reject;
      this.items.push(item);
      this.pump();
    });
    queued.catch(reject);
    this.adding = queued.catch(() => undefined);

    return settled;
  }

  /** Rejects the callers still waiting; their entries stay in the store for the next start. */
  public close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.unsubscribe();
    clearTimeout(this.pauseTimer);

    for (const item of this.items.splice(0)) {
      clearTimeout(item.timer);
      // a late reply must not touch the store: the entry is left for the next start, which replays it
      item.requestId = null;
      const outcome = item.outcome;
      if (outcome?.ok) {
        item.resolve?.(outcome.result);
      } else {
        item.reject?.(SocketException.fromWire(outcome ? outcome.failed.error : CLOSED));
      }
    }
  }

  private async load(): Promise<void> {
    const entries = await this.options.store.pending();
    if (this.closed) {
      return;
    }

    this.items.push(...entries.map((entry) => this.item(entry)));
    this.pump();
  }

  private item(entry: OutboxEntry): Item {
    // only an entry another writer added has no key; createdAt keeps it apart from a reused seq
    return { entry, key: entry.key ?? `${this.keyPrefix}${entry.seq}.${entry.createdAt}`, state: 'queued', requestId: null, timer: undefined };
  }

  private onState(state: ConnectionState, previous: ConnectionState): void {
    if (state === 'closed') {
      this.close();
      return;
    }

    // their replies can no longer arrive; the server joins or replays the resend
    if (previous === 'online') {
      for (const item of this.items) {
        if (item.state === 'sent') {
          this.requeue(item);
        }
      }
    }

    if (state === 'online') {
      this.pump();
    }
  }

  private pump(): void {
    if (this.closed || !this.options.connection.connected || Date.now() < this.pausedUntil) {
      return;
    }

    let unanswered = this.items.filter((item) => item.state === 'sent').length;
    let previous: Item | undefined;

    for (const item of this.items) {
      if (item.state === 'done') {
        continue;
      }

      if (item.state === 'queued') {
        if (unanswered >= this.window || !this.transmit(item, previous)) {
          return;
        }
        unanswered++;
      }

      previous = item;
    }
  }

  private transmit(item: Item, previous: Item | undefined): boolean {
    const request: CommandRequest = { id: this.options.commands.nextId(), name: item.entry.name, payload: item.entry.payload, idempotencyKey: item.key };
    // the server runs it only once its predecessor completed, so neither a resend nor a refusal lets it overtake
    if (previous) {
      request.after = previous.key;
    }

    item.state = 'sent';
    item.requestId = request.id;
    item.timer = setTimeout(() => this.onAckTimeout(item, request.id), this.ackTimeoutMs);

    if (this.options.connection.request<CommandReply>(WIRE_EVENTS.command, request, (reply) => this.onReply(item, request.id, reply))) {
      return true;
    }

    this.requeue(item);
    return false;
  }

  private onReply(item: Item, id: string, reply: CommandReply): void {
    // a later send replaced this request, the connection dropped first, or the queue closed
    if (item.requestId !== id) {
      return;
    }

    clearTimeout(item.timer);
    item.timer = undefined;
    item.requestId = null;

    if (typeof reply !== 'object' || reply === null || typeof reply.ok !== 'boolean') {
      return this.fail(item, MALFORMED_REPLY);
    }

    if (!reply.ok) {
      const error = isSocketError(reply.error) ? reply.error : MALFORMED_REPLY;
      // unauthenticated: the credentials ran out, not the command; it waits for the next connection
      return error.retryable || error.code === 'unauthenticated' ? this.retry(item, error) : this.fail(item, error);
    }

    if ('stream' in reply) {
      return this.fail(item, STREAM_REPLY);
    }

    this.succeed(item, reply.result);
  }

  private onAckTimeout(item: Item, id: string): void {
    if (item.requestId !== id) {
      return;
    }

    this.requeue(item);
    this.pump();
  }

  private requeue(item: Item): void {
    clearTimeout(item.timer);
    item.timer = undefined;
    item.requestId = null;
    item.state = 'queued';
  }

  /** One backoff for the whole queue: its commands are refused for shared reasons ( overload, shutdown, a predecessor ). */
  private retry(item: Item, error: SocketError): void {
    this.requeue(item);

    const now = Date.now();
    if (now < this.pausedUntil) {
      return;
    }

    this.pausedUntil = now + this.policy.delay(this.attempt++, error.retryAfterMs);
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = undefined;
      this.pausedUntil = 0;
      this.pump();
    }, this.pausedUntil - now);
  }

  private succeed(item: Item, result: unknown): void {
    this.attempt = 0;
    item.state = 'done';
    item.outcome = { ok: true, result };
    this.options.store.remove(item.entry.seq).catch(this.onStoreError);
    this.settle();
    this.pump();
  }

  private fail(item: Item, error: SocketError): void {
    const failed: FailedOutboxEntry = { ...item.entry, error, failedAt: Date.now() };
    item.state = 'done';
    item.outcome = { ok: false, failed };
    this.options.store.fail(failed).catch(this.onStoreError);
    this.settle();
    this.pump();
  }

  /** Callers and listeners hear about commands in send order, whatever order their replies came in. */
  private settle(): void {
    while (this.items[0]?.state === 'done') {
      const item = this.items.shift()!;
      const outcome = item.outcome!;

      if (outcome.ok) {
        item.resolve?.(outcome.result);
        this.events.emit('acked', { entry: item.entry, result: outcome.result });
      } else {
        item.reject?.(SocketException.fromWire(outcome.failed.error));
        this.events.emit('failed', { entry: outcome.failed, error: outcome.failed.error });
      }
    }
  }
}
