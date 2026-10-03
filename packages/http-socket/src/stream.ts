import { SocketException, WIRE_EVENTS } from '@spinajs/http-socket-common';
import type { Chunk, ErrorCode, SocketError, StreamEnd, StreamFail } from '@spinajs/http-socket-common';
import { untilAborted } from './limits.js';

export type StreamFrameEvent = typeof WIRE_EVENTS.chunk | typeof WIRE_EVENTS.end | typeof WIRE_EVENTS.fail;

/** A handler result that is answered as a stream reply; stages that store or replay results must pass it through. */
export function isStreamResult(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === 'object' && typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] === 'function';
}

/** How a stream ended: 'ok' after its `end` frame, else the code of its `fail` frame. */
export type StreamOutcome = 'ok' | ErrorCode;

export interface IServerStreamInit {
  /** request id of the command; every frame carries it */
  readonly id: string;
  /** full command name, for messages */
  readonly name: string;
  readonly iterator: AsyncIterator<unknown>;
  /** the command's signal: cancel, disconnect, shutdown, a stall and a refused grant fire it */
  readonly signal: AbortSignal;
  abort(reason: SocketException): void;
  /** credit sent with the request, at most `maxCredits` */
  readonly credits: number;
  readonly maxCredits: number;
  /** covers only the wait for credit; a next() that hangs is bounded by an abort ( cancel, disconnect, shutdown ) */
  readonly stallTimeoutMs: number;
  /** emits one frame; throws when socket.io cannot encode it */
  send(event: StreamFrameEvent, frame: Chunk | StreamEnd | StreamFail): void;
  /** runs one step of the source inside the call's AsyncLocalStorage store */
  within<T>(step: () => Promise<T>): Promise<T>;
  toWire(error: unknown): SocketError;
}

/**
 * The server side of one stream reply. It asks the source for the next item only while the client
 * has credit for it, so a slow consumer slows the producer instead of filling buffers.
 *
 * Nothing bounds the source but a credit stall, cancel, disconnect and shutdown, and all of them only fire
 * its signal: a source must honour its `@Signal()`, or it keeps running ( and holds its stream slot ) until it settles.
 */
export class ServerStream {
  protected credits: number;
  protected seq = 0;
  protected wake: (() => void) | null = null;
  protected outcome: Promise<StreamOutcome> | null = null;
  /** next() and return() calls of the source that have not settled yet */
  protected pending = new Set<Promise<unknown>>();

  constructor(protected readonly init: IServerStreamInit) {
    this.credits = init.credits;
  }

  /** Settles once run() has finished and no next() or return() of the source is pending. */
  public get settled(): Promise<void> {
    return (this.outcome ?? Promise.resolve()).then(async () => {
      while (this.pending.size > 0) {
        await Promise.all(this.pending);
      }
    });
  }

  /** Chunks sent so far. */
  public get sent(): number {
    return this.seq;
  }

  public grant(credits: number): void {
    if (this.init.signal.aborted || !Number.isInteger(credits) || credits < 1) {
      return;
    }

    if (this.credits + credits > this.init.maxCredits) {
      this.init.abort(new SocketException('invalid_argument', `stream credit above the limit of ${this.init.maxCredits} chunks`, { details: { limit: this.init.maxCredits } }));
      return;
    }

    this.credits += credits;
    this.wake?.();
  }

  /** Runs the stream to its `end` or `fail` frame; never rejects. A second call returns the first outcome. */
  public run(): Promise<StreamOutcome> {
    return (this.outcome ??= this.pump());
  }

  protected async pump(): Promise<StreamOutcome> {
    const id = this.init.id;

    try {
      for (;;) {
        await this.creditAvailable();
        const step = await untilAborted(
          this.source(() => this.init.iterator.next()),
          this.init.signal,
        );

        if (step.done) {
          this.init.send(WIRE_EVENTS.end, { id, seq: this.seq });
          return 'ok';
        }

        this.init.send(WIRE_EVENTS.chunk, { id, seq: this.seq, data: step.value === undefined ? null : step.value });
        this.seq++;
        this.credits--;
      }
    } catch (err) {
      return this.fail(err);
    }
  }

  protected fail(err: unknown): ErrorCode {
    let error: SocketError;
    try {
      error = this.init.toWire(err);
    } catch {
      error = { code: 'internal', message: `stream ${this.init.name} failed`, retryable: false };
    }
    // a source still awaiting something learns to stop; a no-op when an abort is what ended the stream
    this.init.abort(SocketException.fromWire(error));

    try {
      this.init.send(WIRE_EVENTS.fail, { id: this.init.id, error });
    } catch {
      // nothing more can reach this client
    }

    // not awaited: return() waits for a pending next(), which a source that ignores its signal never settles
    this.source(async () => this.init.iterator.return?.(undefined)).catch(() => undefined);
    return error.code;
  }

  protected source<T>(call: () => Promise<T>): Promise<T> {
    const step = this.init.within(call);
    const forget = (): void => {
      this.pending.delete(tracked);
    };
    const tracked: Promise<void> = step.then(forget, forget);
    this.pending.add(tracked);
    return step;
  }

  protected creditAvailable(): Promise<void> {
    const signal = this.init.signal;

    if (signal.aborted) {
      return Promise.reject(signal.reason);
    }

    if (this.credits > 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const stall = setTimeout(() => this.init.abort(new SocketException('deadline_exceeded', `stream ${this.init.name} got no credit for ${this.init.stallTimeoutMs} ms`)), this.init.stallTimeoutMs);
      stall.unref?.();

      const settle = () => {
        clearTimeout(stall);
        signal.removeEventListener('abort', onAbort);
        this.wake = null;
      };
      const onAbort = () => {
        settle();
        reject(signal.reason);
      };

      this.wake = () => {
        settle();
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
