import { SocketException, WIRE_EVENTS, isChunk, isSocketError, isStreamEnd, isStreamFail, type CancelFrame, type Chunk, type CommandReply, type CommandRequest, type SocketError, type StreamCredit, type StreamEnd } from '@spinajs/http-socket-common';
import type { CommandOptions } from './commands.js';
import type { Connection, ConnectionState } from './connection.js';
import { assertTimeoutMs } from './timeout.js';

export interface StreamOptions extends CommandOptions {
  /**
   * Chunks the server may send ahead of the consumer: the most that are ever in flight or buffered.
   * More are granted as the consumer reads. At most the server's `http.socket.streams.maxCredits` ( 64 ).
   */
  credits?: number;
}

export const DEFAULT_STREAM_CREDITS = 8;

const CLOSED: SocketError = { code: 'unavailable', message: 'the client is closed', retryable: false };
const OFFLINE: SocketError = { code: 'unavailable', message: 'the client is offline', retryable: true };
const STAYED_OFFLINE: SocketError = { code: 'unavailable', message: 'the client stayed offline until the timeout', retryable: true };
const CONNECTION_LOST: SocketError = { code: 'unavailable', message: 'the connection dropped during the stream', retryable: true };
const NO_REPLY: SocketError = { code: 'deadline_exceeded', message: 'no reply before the timeout', retryable: true };
const NO_FRAME: SocketError = { code: 'deadline_exceeded', message: 'no stream frame before the timeout', retryable: true };
const CANCELLED: SocketError = { code: 'cancelled', message: 'the stream was cancelled', retryable: false };
const NOT_A_STREAM: SocketError = { code: 'failed_precondition', message: 'the command does not reply with a stream; use command()', retryable: false };
const MALFORMED_REPLY: SocketError = { code: 'internal', message: 'malformed reply', retryable: false };
const OUT_OF_ORDER: SocketError = { code: 'internal', message: 'stream frames arrived out of order', retryable: false };
const OVER_CREDIT: SocketError = { code: 'internal', message: 'the server sent more chunks than it had credit for', retryable: false };

type Timer = ReturnType<typeof setTimeout>;

/** idle → (waiting →) sent → open → done; `waiting` only with whenOffline 'wait'. */
type Phase = 'idle' | 'waiting' | 'sent' | 'open' | 'done';

interface StreamHost {
  readonly connection: Connection;
  readonly defaultTimeoutMs: number;
  nextId(): string;
  hold(stream: ClientStream<unknown>): void;
  register(id: string, stream: ClientStream<unknown>): void;
  release(stream: ClientStream<unknown>): void;
}

function assertCredits(value: number): void {
  if (!(Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError(`credits must be a positive integer, got ${value}`);
  }
}

/** Routes stream frames to their ClientStream and fails or resumes streams on connection changes. */
export class StreamDispatcher implements StreamHost {
  private readonly waiting = new Set<ClientStream<unknown>>();
  private readonly open = new Map<string, ClientStream<unknown>>();

  constructor(
    public readonly connection: Connection,
    private readonly ids: () => string,
    public readonly defaultTimeoutMs: number,
  ) {
    assertTimeoutMs('defaultTimeoutMs', defaultTimeoutMs);
    connection.listen(WIRE_EVENTS.chunk, (frame: unknown) => {
      if (isChunk(frame)) this.open.get(frame.id)?.onChunk(frame);
    });
    connection.listen(WIRE_EVENTS.end, (frame: unknown) => {
      if (isStreamEnd(frame)) this.open.get(frame.id)?.onEnd(frame);
    });
    connection.listen(WIRE_EVENTS.fail, (frame: unknown) => {
      if (isStreamFail(frame)) this.open.get(frame.id)?.onFail(frame.error);
    });
    connection.events.on('state', (state, previous) => this.onState(state, previous));
  }

  /** @internal streams held offline plus streams sent or open; 0 once every stream has settled */
  public get activeStreams(): number {
    return this.waiting.size + this.open.size;
  }

  public stream<T>(name: string, payload?: unknown, options: StreamOptions = {}): ClientStream<T> {
    return new ClientStream<T>(this, name, payload, options);
  }

  public nextId(): string {
    return this.ids();
  }

  public hold(stream: ClientStream<unknown>): void {
    this.waiting.add(stream);
  }

  public register(id: string, stream: ClientStream<unknown>): void {
    this.open.set(id, stream);
  }

  public release(stream: ClientStream<unknown>): void {
    this.waiting.delete(stream);
    if (this.open.get(stream.id) === stream) this.open.delete(stream.id);
  }

  private onState(state: ConnectionState, previous: ConnectionState): void {
    if (state === 'closed') {
      for (const stream of [...this.waiting, ...this.open.values()]) stream.abandon(CLOSED);
      return;
    }
    if (previous === 'online') for (const stream of [...this.open.values()]) stream.abandon(CONNECTION_LOST);
    if (state === 'online') for (const stream of [...this.waiting]) stream.transmit();
  }
}

/**
 * One stream reply as an async iterator. It starts on the first `next()`. It keeps
 * `granted − consumed ≤ credits`, so no more than `credits` chunks are ever in flight or buffered.
 */
export class ClientStream<T> implements AsyncIterableIterator<T> {
  private phase: Phase = 'idle';
  private requestId = '';
  private readonly buffer: T[] = [];
  private reader: { resolve(result: IteratorResult<T>): void; reject(error: unknown): void } | null = null;
  private failure: unknown = null;
  private received = 0;
  private granted = 0;
  private consumed = 0;
  private deadlineAt = 0;
  private timer: Timer | undefined;
  private readonly window: number;
  private readonly timeoutMs: number;
  private readonly onAbort = (): void => this.stop(CANCELLED);

  constructor(
    private readonly host: StreamHost,
    private readonly name: string,
    private readonly payload: unknown,
    private readonly options: StreamOptions,
  ) {
    this.window = options.credits ?? DEFAULT_STREAM_CREDITS;
    this.timeoutMs = options.timeoutMs ?? host.defaultTimeoutMs;
  }

  /** The request id; empty until the request is sent. */
  public get id(): string {
    return this.requestId;
  }

  /** @internal chunks received and not yet read */
  public get buffered(): number {
    return this.buffer.length;
  }

  public [Symbol.asyncIterator](): this {
    return this;
  }

  /** Reads one item. Calls must not overlap: a second next() while one is pending rejects with a TypeError. */
  public next(): Promise<IteratorResult<T>> {
    if (this.phase === 'idle') this.start();
    if (this.buffer.length > 0) return Promise.resolve({ value: this.take(), done: false });
    if (this.phase === 'done') return this.failure === null ? Promise.resolve({ value: undefined, done: true }) : Promise.reject(this.failure);
    if (this.reader) return Promise.reject(new TypeError('next() called before the previous next() settled'));
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.reader = { resolve, reject };
      if (this.phase === 'open') this.arm(this.timeoutMs, NO_FRAME);
    });
  }

  /** `for await` calls it on break or throw: the server is told to stop and its generator's `finally` runs. */
  public async return(): Promise<IteratorResult<T>> {
    this.stop(null);
    this.failure = null;
    return { value: undefined, done: true };
  }

  /** @internal sends the request now, or again once online for a held stream */
  public transmit(): void {
    if (this.phase !== 'idle' && this.phase !== 'waiting') return;
    this.host.release(this);
    this.requestId = this.host.nextId();
    this.granted = this.window;
    this.phase = 'sent';
    this.host.register(this.requestId, this);

    const remaining = Math.max(1, this.deadlineAt - Date.now());
    // deadline: relative, so client/server clock skew cannot expire it; it bounds the reply only
    const request: CommandRequest = { id: this.requestId, name: this.name, payload: this.payload, credits: this.window, deadline: remaining };
    if (this.options.traceparent !== undefined) request.traceparent = this.options.traceparent;

    this.arm(remaining, NO_REPLY);
    const sent = this.host.connection.request<CommandReply>(WIRE_EVENTS.command, request, (reply) => this.onReply(reply));
    if (!sent) this.finish(CONNECTION_LOST);
  }

  /** @internal */
  public onChunk(frame: Chunk): void {
    if (this.phase !== 'sent' && this.phase !== 'open') return;
    if (frame.seq !== this.received) return this.stop(OUT_OF_ORDER);
    if (this.received >= this.granted) return this.stop(OVER_CREDIT);
    this.received++;

    const value = frame.data as T;
    const reader = this.reader;
    if (!reader) {
      this.buffer.push(value);
      return;
    }
    this.reader = null;
    // before the ack the armed timer is the reply timeout, which must keep running
    if (this.phase === 'open') this.disarm();
    this.consumed++;
    this.replenish();
    reader.resolve({ value, done: false });
  }

  /** @internal */
  public onEnd(frame: StreamEnd): void {
    if (this.phase !== 'sent' && this.phase !== 'open') return;
    if (frame.seq !== this.received) return this.stop(OUT_OF_ORDER);
    this.finish(null);
  }

  /** @internal the chunks received before the failure are still delivered */
  public onFail(error: SocketError): void {
    if (this.phase !== 'sent' && this.phase !== 'open') return;
    this.finish(error);
  }

  /** @internal the connection dropped or the client closed; the chunks received are still delivered */
  public abandon(error: SocketError): void {
    this.finish(error);
  }

  private start(): void {
    try {
      assertTimeoutMs('timeoutMs', this.timeoutMs);
      assertCredits(this.window);
    } catch (error) {
      this.phase = 'done';
      this.failure = error;
      return;
    }

    const connection = this.host.connection;
    if (connection.state === 'closed') return this.finish(CLOSED);
    if (this.options.signal?.aborted) return this.finish(CANCELLED);
    if (!connection.connected && (this.options.whenOffline ?? 'fail') === 'fail') return this.finish(OFFLINE);

    this.deadlineAt = Date.now() + this.timeoutMs;
    this.options.signal?.addEventListener('abort', this.onAbort, { once: true });
    if (connection.connected) return this.transmit();

    this.phase = 'waiting';
    this.host.hold(this);
    this.arm(this.timeoutMs, STAYED_OFFLINE);
  }

  private onReply(reply: CommandReply): void {
    if (this.phase !== 'sent') return;
    if (typeof reply !== 'object' || reply === null || typeof reply.ok !== 'boolean') return this.stop(MALFORMED_REPLY);
    if (!reply.ok) return this.finish(isSocketError(reply.error) ? reply.error : MALFORMED_REPLY);
    if (!('stream' in reply) || reply.stream !== true) return this.finish(NOT_A_STREAM);

    this.phase = 'open';
    this.disarm();
    // chunks read before the ack were not credited back
    this.replenish();
    if (this.reader) this.arm(this.timeoutMs, NO_FRAME);
  }

  private take(): T {
    const value = this.buffer.shift() as T;
    this.consumed++;
    this.replenish();
    return value;
  }

  /** Grants in batches of at least half the window, so a fast consumer does not send one frame per chunk. */
  private replenish(): void {
    if (this.phase !== 'open') return;
    const free = this.window - (this.granted - this.consumed);
    if (free < Math.max(1, Math.floor(this.window / 2))) return;
    const credit: StreamCredit = { id: this.requestId, credits: free };
    if (this.host.connection.send(WIRE_EVENTS.credit, credit)) this.granted += free;
  }

  /** Ends the stream from this side: buffered items are dropped and the server is told to stop. */
  private stop(error: SocketError | null): void {
    this.buffer.length = 0;
    if (this.phase === 'sent' || this.phase === 'open') {
      const cancel: CancelFrame = { id: this.requestId };
      this.host.connection.send(WIRE_EVENTS.cancel, cancel);
    }
    this.finish(error);
  }

  private finish(error: SocketError | null): void {
    if (this.phase === 'done') return;
    this.phase = 'done';
    this.disarm();
    this.options.signal?.removeEventListener('abort', this.onAbort);
    this.host.release(this);
    if (error !== null) this.failure = SocketException.fromWire(error);

    // a waiting reader means the buffer is empty
    const reader = this.reader;
    if (!reader) return;
    this.reader = null;
    if (this.failure === null) reader.resolve({ value: undefined, done: true });
    else reader.reject(this.failure);
  }

  private arm(ms: number, error: SocketError): void {
    this.disarm();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.stop(error);
    }, ms);
  }

  private disarm(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
