import { SocketException } from '@spinajs/http-socket-common';

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

  constructor(
    protected readonly perSecond: number,
    protected readonly burst: number,
    protected readonly now: () => number = () => performance.now(),
  ) {
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
  const size = payloadSize(payload);

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
