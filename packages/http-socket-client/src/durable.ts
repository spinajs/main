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
  /**
   * Largest JSON-encoded payload, binary parts counted by length; the server's default limit. Checked
   * before the command is persisted: one the server refuses for size would otherwise sit in the outbox.
   */
  maxPayloadBytes?: number;
}

export interface DurableCommandOptions {
  /**
   * Idempotency key, eg. an op id: 1-MAX_KEY_LENGTH printable ASCII characters, not starting with `${clientId}:`.
   * When omitted, `${clientId}:${random nonce}` is generated and persisted with the entry.
   */
  key?: string;
}

export const DEFAULT_DURABLE: Readonly<Required<DurableOptions>> = Object.freeze({ window: 16, ackTimeoutMs: 60_000, maxPayloadBytes: 1024 * 1024 });

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
const UNENCODABLE: SocketError = { code: 'invalid_argument', message: 'the payload cannot be serialized', retryable: false };

type Timer = ReturnType<typeof setTimeout>;
type Outcome = { ok: true; result: unknown } | { ok: false; failed: FailedOutboxEntry };

interface Item {
  readonly entry: OutboxEntry;
  readonly key: string;
  state: 'queued' | 'sent' | 'done';
  /** sent while the queue probed with its head alone */
  probe: boolean;
  /** requests whose final reply counts: the latest send, and those an ack timeout sent again on this connection */
  readonly outstanding: Set<string>;
  timer: Timer | undefined;
  outcome?: Outcome;
  /** the store has applied the outcome */
  stored: boolean;
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
  private readonly maxPayloadBytes: number;
  private readonly onStoreError: (error: unknown) => void;
  private readonly unsubscribe: () => void;
  /** generated keys start with it; app keys must not */
  private readonly keyPrefix: string;
  private loading: Promise<void> | undefined;
  private adding: Promise<unknown> = Promise.resolve();
  private attempt = 0;
  private pausedUntil = 0;
  private pauseTimer: Timer | undefined;
  // after a retryable refusal only the head goes out: its successors would only be fenced
  private probing = false;
  // the credentials ran out: nothing goes out before the next connection, which a re-login opens
  private heldUntilOnline = false;
  private closed = false;

  constructor(private readonly options: DurableQueueOptions) {
    const { window, ackTimeoutMs, maxPayloadBytes } = { ...DEFAULT_DURABLE, ...options.durable };
    if (!(Number.isInteger(window) && window >= 1)) {
      throw new RangeError(`durable.window must be an integer of at least 1, got ${window}`);
    }

    if (!(Number.isInteger(maxPayloadBytes) && maxPayloadBytes >= 1)) {
      throw new RangeError(`durable.maxPayloadBytes must be an integer of at least 1, got ${maxPayloadBytes}`);
    }

    // `${clientId}:${nonce}` must stay a key the server accepts
    if (!isId(options.clientId)) {
      throw new RangeError(`clientId must be 1-${MAX_ID_LENGTH} printable ASCII characters`);
    }

    this.keyPrefix = `${options.clientId}:`;
    this.window = window;
    this.maxPayloadBytes = maxPayloadBytes;
    this.ackTimeoutMs = assertTimeoutMs('durable.ackTimeoutMs', ackTimeoutMs);
    this.policy = new ReconnectPolicy(options.reconnect);
    this.onStoreError = options.onListenerError ?? rethrowAsync;
    this.events = new Emitter<DurableEvents>(options.onListenerError);
    this.unsubscribe = options.connection.events.on('state', (state, previous) => this.onState(state, previous));
    this.load().catch(this.onStoreError);
  }

  /** Commands not yet settled to their callers, resumed ones included. */
  public get size(): number {
    return this.items.length;
  }

  /**
   * Persists the command, then sends it in order. Resolves with its result once it and every earlier
   * command have settled. Rejects when the server refuses it for good ( it is then in the store's
   * failed list ) or when the queue closes ( it stays in the outbox ). A caller that does not await
   * it attaches a catch, or follows the `acked` and `failed` events instead.
   */
  public submit(name: string, payload: unknown, options: DurableCommandOptions = {}): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(SocketException.fromWire(CLOSED));
    }

    if (options.key !== undefined && (!isKey(options.key) || options.key.startsWith(this.keyPrefix))) {
      return Promise.reject(new RangeError(`a durable command key must be 1-${MAX_KEY_LENGTH} printable ASCII characters and must not start with '${this.keyPrefix}'`));
    }

    let size: number;
    try {
      size = payloadSize(payload);
    } catch {
      return Promise.reject(SocketException.fromWire(UNENCODABLE));
    }

    if (size > this.maxPayloadBytes) {
      return Promise.reject(SocketException.fromWire({ code: 'invalid_argument', message: `payload of ${size} bytes exceeds the limit of ${this.maxPayloadBytes} bytes`, retryable: false, details: { size, limit: this.maxPayloadBytes } }));
    }

    let resolve!: (result: unknown) => void;
    let reject!: (error: unknown) => void;
    const settled = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    // one add at a time, and the item joins the queue inside that turn: items stay in seq order
    const queued = this.adding.then(async () => {
      await this.load();
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

  /**
   * Rejects the callers still waiting; their entries stay in the store for the next start. Commands
   * already answered but waiting for an earlier one are reported first, in order.
   */
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
      item.outstanding.clear();
      if (item.outcome) {
        this.report(item, item.outcome);
      } else {
        item.reject?.(SocketException.fromWire(CLOSED));
      }
    }
  }

  /** Reads the store once; a failed read is tried again by the next submit(). */
  private load(): Promise<void> {
    if (this.loading === undefined) {
      this.loading = this.options.store.pending().then(
        (entries) => {
          if (!this.closed) {
            this.items.push(...entries.map((entry) => this.item(entry)));
            this.pump();
          }
        },
        (error: unknown) => {
          this.loading = undefined;
          throw error;
        },
      );
    }

    return this.loading;
  }

  private item(entry: OutboxEntry): Item {
    // only an entry another writer added has no key; createdAt keeps it apart from a reused seq
    return { entry, key: entry.key ?? `${this.keyPrefix}${entry.seq}.${entry.createdAt}`, state: 'queued', probe: false, outstanding: new Set(), timer: undefined, stored: false };
  }

  private onState(state: ConnectionState, previous: ConnectionState): void {
    if (state === 'closed') {
      this.close();
      return;
    }

    // their replies can no longer arrive; the server joins or replays the resend
    if (previous === 'online') {
      for (const item of this.items) {
        item.outstanding.clear();
        if (item.state === 'sent') {
          this.requeue(item);
        }
      }
    }

    if (state === 'online') {
      this.heldUntilOnline = false;
      this.pump();
    }
  }

  private pump(): void {
    if (this.closed || this.heldUntilOnline || !this.options.connection.connected || Date.now() < this.pausedUntil) {
      return;
    }

    const window = this.probing ? 1 : this.window;
    let unanswered = this.items.filter((item) => item.state === 'sent').length;
    let previous: Item | undefined;

    for (const item of this.items) {
      if (item.state === 'done') {
        continue;
      }

      if (item.state === 'queued') {
        if (unanswered >= window || !this.transmit(item, previous)) {
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
    item.probe = this.probing;
    item.outstanding.add(request.id);
    item.timer = setTimeout(() => this.onAckTimeout(item, request.id), this.ackTimeoutMs);

    if (this.options.connection.request<CommandReply>(WIRE_EVENTS.command, request, (reply) => this.onReply(item, request.id, reply))) {
      return true;
    }

    item.outstanding.delete(request.id);
    this.requeue(item);
    return false;
  }

  private onReply(item: Item, id: string, reply: CommandReply): void {
    // the connection dropped first, the queue closed, or another request for it was answered
    if (!item.outstanding.has(id)) {
      return;
    }

    const error = replyError(reply);
    if (error === undefined) {
      return this.succeed(item, (reply as { result?: unknown }).result);
    }

    if (!error.retryable && error.code !== 'unauthenticated') {
      return this.fail(item, error);
    }

    item.outstanding.delete(id);
    // a later request for it is still out and answers for it
    if (item.outstanding.size > 0) {
      return;
    }

    // the credentials ran out, not the command
    if (error.code === 'unauthenticated') {
      this.requeue(item);
      this.heldUntilOnline = true;
      return;
    }

    this.retry(item, error);
  }

  private onAckTimeout(item: Item, id: string): void {
    if (item.state !== 'sent' || !item.outstanding.has(id)) {
      return;
    }

    // the request stays outstanding: whichever reply comes first counts
    this.requeue(item);
    this.pump();
  }

  private requeue(item: Item): void {
    clearTimeout(item.timer);
    item.timer = undefined;
    item.state = 'queued';
  }

  /** One backoff for the whole queue: its commands are refused for shared reasons ( overload, shutdown ). */
  private retry(item: Item, error: SocketError): void {
    this.requeue(item);

    // fenced: its predecessor had not completed; it goes again right behind it
    if (isFenceRefusal(error)) {
      this.pump();
      return;
    }

    this.probing = true;
    const now = Date.now();
    if (now < this.pausedUntil) {
      return;
    }

    clearTimeout(this.pauseTimer);
    this.pausedUntil = now + this.policy.delay(this.attempt++, error.retryAfterMs);
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = undefined;
      this.pausedUntil = 0;
      this.pump();
    }, this.pausedUntil - now);
  }

  private succeed(item: Item, result: unknown): void {
    this.finish(item, { ok: true, result });
    if (!this.probing) {
      this.attempt = 0;
    }

    this.record(item, () => this.options.store.remove(item.entry.seq));
  }

  private fail(item: Item, error: SocketError): void {
    const failed: FailedOutboxEntry = { ...item.entry, error, failedAt: Date.now() };
    this.finish(item, { ok: false, failed });
    this.record(item, () => this.options.store.fail(failed));
  }

  private finish(item: Item, outcome: Outcome): void {
    clearTimeout(item.timer);
    item.timer = undefined;
    item.outstanding.clear();
    // the probed head has its final answer: the window opens again
    if (item.probe) {
      this.probing = false;
    }

    item.state = 'done';
    item.outcome = outcome;
  }

  /** The caller hears of an outcome only once the store holds it, so a reload cannot undo what it was told. */
  private record(item: Item, write: () => Promise<void>): void {
    Promise.resolve()
      .then(write)
      .catch(this.onStoreError)
      .then(() => {
        item.stored = true;
        this.settle();
      });
    this.pump();
  }

  /** Callers and listeners hear about commands in send order, whatever order their replies came in. */
  private settle(): void {
    while (this.items[0]?.state === 'done' && this.items[0].stored) {
      const item = this.items.shift()!;
      this.report(item, item.outcome!);
    }
  }

  private report(item: Item, outcome: Outcome): void {
    if (outcome.ok) {
      item.resolve?.(outcome.result);
      this.events.emit('acked', { entry: item.entry, result: outcome.result });
    } else {
      item.reject?.(SocketException.fromWire(outcome.failed.error));
      this.events.emit('failed', { entry: outcome.failed, error: outcome.failed.error });
    }
  }
}

/** undefined for a result */
function replyError(reply: CommandReply): SocketError | undefined {
  if (typeof reply !== 'object' || reply === null || typeof reply.ok !== 'boolean') {
    return MALFORMED_REPLY;
  }

  if (!reply.ok) {
    return isSocketError(reply.error) ? reply.error : MALFORMED_REPLY;
  }

  return 'stream' in reply ? STREAM_REPLY : undefined;
}

function isFenceRefusal(error: SocketError): boolean {
  return typeof error.details === 'object' && error.details !== null && 'after' in error.details;
}

/** What the server's size limit measures: the JSON text in UTF-8, binary parts by their length. */
function payloadSize(payload: unknown): number {
  let binary = 0;
  const json = JSON.stringify(payload, function (this: Record<string, unknown>, key: string, value: unknown) {
    // `value` has been through toJSON already; binary parts are detected on the raw holder value
    const raw = this[key];
    if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
      binary += raw.byteLength;
      return null;
    }
    return value;
  });
  return binary + (json === undefined ? 0 : new TextEncoder().encode(json).length);
}
