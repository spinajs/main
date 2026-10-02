import { SocketException } from '@spinajs/http-socket-common';
import type { IConnectionRuntime, ISocketServerConfig } from './interfaces.js';

/**
 * Wire size of a command payload: the UTF-8 length of its JSON form plus the bytes of every
 * binary part (socket.io sends those as attachments, not as JSON).
 */
export function payloadSize(value: unknown): number {
  let binary = 0;

  const json = JSON.stringify(value, function (this: Record<string, unknown>, key: string, current: unknown) {
    // `current` has already been through toJSON (a Buffer arrives as {type, data}), so binary
    // parts are detected on the raw holder value.
    const raw = this[key];
    if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
      binary += raw.byteLength;
      return null;
    }

    return current;
  });

  return binary + (json === undefined ? 0 : Buffer.byteLength(json, 'utf8'));
}

export class TokenBucket {
  protected tokens: number;
  protected last: number;

  constructor(protected readonly perSecond: number, protected readonly burst: number, protected readonly now: () => number = () => performance.now()) {
    this.tokens = burst;
    this.last = now();
  }

  public take(): boolean {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }

    return false;
  }

  public retryAfterMs(): number {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) * 1000) / this.perSecond);
  }

  protected refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) * this.perSecond) / 1000);
    this.last = t;
  }
}

export function assertPayloadSize(payload: unknown, maxBytes: number): void {
  let size: number;

  try {
    size = payloadSize(payload);
  } catch (err) {
    // BigInt and cyclic values cannot be serialized, so they could never be sent as a command payload
    throw new SocketException('invalid_argument', 'payload cannot be serialized', { cause: err });
  }

  if (size > maxBytes) {
    throw new SocketException('resource_exhausted', `payload of ${size} bytes exceeds the limit of ${maxBytes} bytes`, {
      retryable: false,
      details: { size, limit: maxBytes },
    });
  }
}

export function assertRate(bucket: TokenBucket): void {
  if (!bucket.take()) {
    throw new SocketException('resource_exhausted', 'rate limit exceeded', { retryAfterMs: bucket.retryAfterMs() });
  }
}

export function assertLimitsConfig(options: Pick<ISocketServerConfig, 'rate' | 'maxInFlightEventsPerConnection'>): void {
  const { perSecond, burst } = options.rate;

  if (!(perSecond > 0) || !(burst > 0)) {
    throw new RangeError(`http.socket.rate.perSecond and burst must be positive numbers, got perSecond ${perSecond}, burst ${burst}`);
  }

  // a cap below the burst would drop events the rate limit lets through
  const cap = options.maxInFlightEventsPerConnection;
  if (!(Number.isInteger(cap) && cap > 0 && cap >= burst)) {
    throw new RangeError(`http.socket.maxInFlightEventsPerConnection must be an integer of at least rate.burst ( ${burst} ), got ${String(cap)}`);
  }
}

export function assertHooksConfig(options: Pick<ISocketServerConfig, 'hooks'>): void {
  const timeout = options.hooks?.connectTimeoutMs;

  if (!(typeof timeout === 'number' && timeout > 0)) {
    throw new RangeError(`http.socket.hooks.connectTimeoutMs must be a positive number, got ${String(timeout)}`);
  }
}

export function assertOrderingConfig(options: Pick<ISocketServerConfig, 'ordering'>): void {
  const grace = options.ordering?.abortGraceMs;

  if (!(typeof grace === 'number' && grace > 0)) {
    throw new RangeError(`http.socket.ordering.abortGraceMs must be a positive number, got ${String(grace)}`);
  }
}

/** Runs `work` holding one of `max` slots of the counter, refusing when none is free; the slot is given back when `work` settles. */
export async function withSlot<T>(runtime: IConnectionRuntime, counter: 'inFlight' | 'eventsInFlight', noun: 'commands' | 'events', max: number, work: () => Promise<T>, retryAfterMs?: number): Promise<T> {
  if (runtime[counter] >= max) {
    throw new SocketException('resource_exhausted', `more than ${max} ${noun} in flight on this connection`, retryAfterMs === undefined ? undefined : { retryAfterMs });
  }

  runtime[counter]++;
  try {
    return await work();
  } finally {
    runtime[counter]--;
  }
}

export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
