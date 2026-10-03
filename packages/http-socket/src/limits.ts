import { SocketException } from '@spinajs/http-socket-common';
import type { IConnectionRuntime, ISocketServerConfig, SocketTransport } from './interfaces.js';

const TRANSPORTS: readonly SocketTransport[] = ['websocket', 'polling'];

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

export function assertLimitsConfig(options: Pick<ISocketServerConfig, 'rate' | 'maxPayloadBytes' | 'maxInFlightPerConnection' | 'maxInFlightEventsPerConnection' | 'auth' | 'transports'>): void {
  const { perSecond, burst } = options.rate;

  if (!(perSecond > 0) || !(burst > 0)) {
    throw new RangeError(`http.socket.rate.perSecond and burst must be positive numbers, got perSecond ${perSecond}, burst ${burst}`);
  }

  // a cap below the burst would drop events the rate limit lets through
  const cap = options.maxInFlightEventsPerConnection;
  if (!(Number.isInteger(cap) && cap > 0 && cap >= burst)) {
    throw new RangeError(`http.socket.maxInFlightEventsPerConnection must be an integer of at least rate.burst ( ${burst} ), got ${String(cap)}`);
  }

  if (!(Number.isInteger(options.maxPayloadBytes) && options.maxPayloadBytes > 0)) {
    throw new RangeError(`http.socket.maxPayloadBytes must be an integer above 0, got ${String(options.maxPayloadBytes)}`);
  }

  if (!(Number.isInteger(options.maxInFlightPerConnection) && options.maxInFlightPerConnection > 0)) {
    throw new RangeError(`http.socket.maxInFlightPerConnection must be an integer above 0, got ${String(options.maxInFlightPerConnection)}`);
  }

  const revalidateMs = options.auth?.revalidateMs;
  if (!(typeof revalidateMs === 'number' && Number.isFinite(revalidateMs) && revalidateMs >= 0)) {
    throw new RangeError(`http.socket.auth.revalidateMs must be a finite number of at least 0, got ${String(revalidateMs)}`);
  }

  // undefined leaves socket.io's default
  const transports: unknown = options.transports;
  if (transports !== undefined && !(Array.isArray(transports) && transports.length > 0 && transports.every((t) => TRANSPORTS.includes(t as SocketTransport)))) {
    throw new RangeError(`http.socket.transports must be a non-empty list of ${TRANSPORTS.map((t) => `'${t}'`).join(', ')}, got ${JSON.stringify(transports)}`);
  }
}

export function assertHooksConfig(options: Pick<ISocketServerConfig, 'hooks'>): void {
  const timeout = options.hooks?.connectTimeoutMs;

  if (!(typeof timeout === 'number' && timeout > 0)) {
    throw new RangeError(`http.socket.hooks.connectTimeoutMs must be a positive number, got ${String(timeout)}`);
  }
}

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export function assertStreamsConfig(options: Pick<ISocketServerConfig, 'streams'>): void {
  const streams = options.streams;
  const positiveInteger = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0;

  if (!positiveInteger(streams?.maxCredits) || !positiveInteger(streams?.maxPerConnection)) {
    throw new RangeError(`http.socket.streams.maxCredits and maxPerConnection must be integers above 0, got maxCredits ${String(streams?.maxCredits)}, maxPerConnection ${String(streams?.maxPerConnection)}`);
  }

  if (!(positiveInteger(streams.stallTimeoutMs) && streams.stallTimeoutMs <= MAX_TIMER_DELAY_MS)) {
    throw new RangeError(`http.socket.streams.stallTimeoutMs must be an integer within 1 and ${MAX_TIMER_DELAY_MS}, got ${String(streams.stallTimeoutMs)}`);
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

const MAX_TIMER_MS = 2 ** 31 - 1;

export function assertShutdownConfig(options: Pick<ISocketServerConfig, 'drainMs' | 'shutdownRetryAfterMs'>): void {
  const { drainMs, shutdownRetryAfterMs } = options;

  if (!(typeof drainMs === 'number' && drainMs >= 0 && drainMs <= MAX_TIMER_MS)) {
    throw new RangeError(`http.socket.drainMs must be within [0, ${MAX_TIMER_MS}], got ${String(drainMs)}`);
  }

  if (!(typeof shutdownRetryAfterMs === 'number' && shutdownRetryAfterMs > 0 && Number.isFinite(shutdownRetryAfterMs))) {
    throw new RangeError(`http.socket.shutdownRetryAfterMs must be a finite number above 0, got ${String(shutdownRetryAfterMs)}`);
  }
}
