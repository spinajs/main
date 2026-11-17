// Symbol.for: transports may load another copy of @spinajs/queue, whose class `instanceof` would not match.
const REDELIVER = Symbol.for('spinajs:queue:redeliver-later');

/** The handler asks for this delivery again after `delayMs`, whatever the retry policy says; a transport must never ack it. */
export class RedeliverLater extends Error {
  constructor(
    public readonly delayMs: number,
    cause?: unknown,
  ) {
    super(`redeliver in ${delayMs} ms`, { cause });
    this.name = 'RedeliverLater';
    Object.defineProperty(this, REDELIVER, { value: true });
  }
}

export function isRedeliverLater(error: unknown): error is RedeliverLater {
  return typeof error === 'object' && error !== null && Object.getOwnPropertyDescriptor(error, REDELIVER)?.value === true;
}
