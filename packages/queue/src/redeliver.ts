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

/** How long the queue waits before it redelivers an event whose dedup claim failed. A `250 * 2^n` value, so AMQP's forced-delay bucket equals it. */
export const CLAIM_FAILURE_REDELIVERY_MS = 1000;

export function isRedeliverLater(error: unknown): error is RedeliverLater {
  return typeof error === 'object' && error !== null && Object.getOwnPropertyDescriptor(error, REDELIVER)?.value === true;
}
