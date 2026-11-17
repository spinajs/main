import { DateTime } from 'luxon';
import { InvalidArgument } from '@spinajs/exceptions';
import type { Constructor } from '@spinajs/di';
import { NonRetryableError } from '@spinajs/durable';
import { isCrash } from './crash.js';
import { QueueHeaders } from './headers.js';
import { isPermanentJobFailure } from './hooks.js';
import { QueueMessageType, isJob } from './interfaces.js';
import type { DeliveryBackoff, IQueueMessage, QueueClient, QueueMessage } from './interfaces.js';
import { isRedeliverLater } from './redeliver.js';

export const DELIVERY_ERROR_MAX_LENGTH = 1024;

export interface DeliveryPolicy {
  maxRetries: number;
  backoff: DeliveryBackoff;
  deadLetterChannel?: string;
  onEventFailure: 'drop' | 'retry';
}

export type DeliveryDecision =
  | { action: 'ack'; dropped?: true; reason?: string }
  | { action: 'retry'; attempt: number; delayMs: number; headers: Record<string, string>; forced?: true }
  | { action: 'dead-letter'; channel: string | undefined; reason: 'exhausted' | 'non-retryable' | 'unparseable'; headers: Record<string, string> };

export class UnparseableMessageError extends Error {
  constructor(cause: unknown) {
    super(`unparseable message body: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'UnparseableMessageError';
  }
}

/** Stands in for a body that could not be parsed: no Name, so only the connection defaults apply. */
export function unparseableMessage(): IQueueMessage {
  return { Name: '', Type: QueueMessageType.Job, CreatedAt: DateTime.fromMillis(0), Persistent: true, Priority: 0 };
}

/** A number is what the AMQP transport of 3.x writes, so retry copies from before an upgrade carry one. */
export function retryCountOf(headers: Record<string, unknown> | undefined): number {
  const raw = headers?.[QueueHeaders.RetryCount];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : 0;
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

// setTimeout fires at once past 2^31 - 1 ms (about 24.8 days), so a transport timer cannot wait longer
const MAX_DELAY_MS = 2 ** 31 - 1;

/** A whole number of milliseconds a timer can wait: NaN and negatives are 0, anything too long is the timer's limit. */
const toDelay = (ms: number): number => (Number.isNaN(ms) ? 0 : Math.min(Math.max(0, Math.round(ms)), MAX_DELAY_MS));

export function backoffDelay(backoff: DeliveryBackoff, attempt: number): number {
  // 0 * 2^1024 is NaN, not 0
  const delay = backoff.kind === 'fixed' || backoff.delayMs === 0 ? backoff.delayMs : backoff.delayMs * 2 ** (attempt - 1);
  return toDelay(backoff.maxDelayMs === undefined ? delay : Math.min(delay, backoff.maxDelayMs));
}

// a rejection value is anything a handler throws; one that cannot be turned into text must not make the decision throw
const errorText = (error: unknown): string => {
  try {
    return (error instanceof Error ? error.message || error.name : String(error)).slice(0, DELIVERY_ERROR_MAX_LENGTH);
  } catch {
    return 'unknown error';
  }
};

/** `instanceof` for subclasses, which rename themselves; the name for another copy of `@spinajs/durable`, where `instanceof` fails. */
export const isNonRetryableFailure = (error: unknown): boolean => isPermanentJobFailure(error) || error instanceof NonRetryableError || (error instanceof Error && error.name === 'NonRetryableError');

/**
 * The one retry / dead-letter / drop rule every transport executes. `attempt` is the received copy's `x-retry-count`.
 * Only a `RedeliverLater` itself bypasses the retry count: the queue throws one for an in-flight duplicate only, and a
 * handler's own failure, an `IdempotencyInFlight` included, goes through the policy.
 */
export function decideDelivery(message: IQueueMessage, attempt: number, error: unknown, policy: DeliveryPolicy): DeliveryDecision {
  if (isCrash(error)) {
    throw new InvalidArgument('decideDelivery: a crash is never decided; the transport leaves the message unsettled');
  }

  const reason = errorText(error);
  const headers = (retryCount?: number): Record<string, string> => ({
    ...(message.MessageId ? { [QueueHeaders.MessageId]: message.MessageId } : {}),
    [QueueHeaders.Error]: reason,
    ...(retryCount === undefined ? {} : { [QueueHeaders.RetryCount]: String(retryCount) }),
  });

  if (isRedeliverLater(error)) {
    return { action: 'retry', attempt, delayMs: toDelay(error.delayMs), headers: headers(attempt), forced: true };
  }
  if (error instanceof UnparseableMessageError) {
    return { action: 'dead-letter', channel: policy.deadLetterChannel, reason: 'unparseable', headers: headers() };
  }
  if (message.Type !== QueueMessageType.Job && policy.onEventFailure === 'drop') {
    return { action: 'ack', dropped: true, reason };
  }
  if (isNonRetryableFailure(error)) {
    return { action: 'dead-letter', channel: policy.deadLetterChannel, reason: 'non-retryable', headers: headers(attempt) };
  }
  if (attempt < policy.maxRetries) {
    return { action: 'retry', attempt: attempt + 1, delayMs: backoffDelay(policy.backoff, attempt + 1), headers: headers(attempt + 1) };
  }
  return { action: 'dead-letter', channel: policy.deadLetterChannel, reason: 'exhausted', headers: headers(attempt) };
}

export function resolveDeliveryPolicy(client: QueueClient, message: IQueueMessage): DeliveryPolicy {
  const routed = client.getMaxRetriesForMessage(message);
  return {
    maxRetries: (isJob(message) ? (message.RetryCount ?? routed) : routed) ?? 0,
    backoff: client.getRouteOption(message, 'backoff') ?? { kind: 'exponential', delayMs: client.Options.retryDelay ?? 0 },
    deadLetterChannel: client.getDeadLetterChannelForMessage(message),
    onEventFailure: client.getRouteOption(message, 'onEventFailure') ?? 'drop',
  };
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

// the values come from configuration, so they are checked as unknown, whatever IMessageRoutingOption says
const isBackoff = (v: unknown): v is DeliveryBackoff => {
  if (typeof v !== 'object' || v === null) return false;
  const kind: unknown = Reflect.get(v, 'kind');
  const maxDelayMs: unknown = Reflect.get(v, 'maxDelayMs');
  return (kind === 'fixed' || kind === 'exponential') && isCount(Reflect.get(v, 'delayMs')) && (maxDelayMs === undefined || isCount(maxDelayMs));
};

/** Called by consume(): a bad routing value fails the subscription, not the failure handler that would read it. */
export function assertDeliveryRouting(client: QueueClient, event: Constructor<QueueMessage>): void {
  const backoff: unknown = client.getRouteOption(event, 'backoff');
  if (backoff !== undefined && !isBackoff(backoff)) {
    throw new InvalidArgument(`queue.routing.${event.name}.backoff must be { kind: 'fixed' | 'exponential', delayMs: integer >= 0, maxDelayMs?: integer >= 0 }`);
  }
  const onEventFailure: unknown = client.getRouteOption(event, 'onEventFailure');
  if (onEventFailure !== undefined && onEventFailure !== 'drop' && onEventFailure !== 'retry') {
    throw new InvalidArgument(`queue.routing.${event.name}.onEventFailure must be 'drop' or 'retry'`);
  }
  const groupBy: unknown = client.getRouteOption(event, 'groupBy');
  if (groupBy !== undefined && (typeof groupBy !== 'string' || groupBy.trim() === '')) {
    throw new InvalidArgument(`queue.routing.${event.name}.groupBy must name a message field`);
  }
}
