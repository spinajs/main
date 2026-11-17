import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Injectable } from '@spinajs/di';
import { QueueMessageHook, isPermanentJobFailure } from '@spinajs/queue';
import type { IQueueMessage } from '@spinajs/queue';

import { AuditWriteFailed, audit, trailConfig } from '../index.js';
import type { AuditInput, AuditOutcome, AuditWriteOptions } from '../index.js';
import { messageRuleOf } from './rules.js';
import type { MessageRule } from './rules.js';

// A failed job goes through aroundHandle again for onFailed; that pass is not another execution.
const failed = new WeakSet<IQueueMessage>();

const optionsOf = (rule: MessageRule): AuditWriteOptions => ({
  trail: rule.trail,
  ...(rule.onFailure ? { onFailure: rule.onFailure } : {}),
  ...(rule.omit ? { omit: rule.omit } : {}),
  ...(rule.mask ? { mask: rule.mask } : {}),
  ...(rule.hash ? { hash: rule.hash } : {}),
});

const errorName = (error: unknown): string => {
  if (!(error instanceof Error)) return typeof error;
  return error.name !== 'Error' ? error.name : error.constructor.name;
};

function details(message: IQueueMessage, rule: MessageRule): Record<string, unknown> {
  const fields = Object.fromEntries((rule.fields ?? []).map((field): [string, unknown] => [field, Reflect.get(message, field)]));
  const initiator = message.Initiator ? `${message.Initiator.type}:${message.Initiator.id}` : undefined;

  return { message: message.Name, type: message.Type, ...(initiator ? { initiator } : {}), ...(rule.fields?.length ? { fields } : {}) };
}

function eventOf(message: IQueueMessage, action: string, outcome: AuditOutcome, data: Record<string, unknown>): AuditInput {
  const id = message.MessageId;
  return { kind: 'action', action, outcome, ...(id ? { subject: { type: message.Name, id } } : {}), data };
}

/**
 * Records publishes and executions of message classes that carry `@Audited`. Hooks nest in registration order: import this
 * module after `@spinajs/authz-queue` and the job's principal is the actor of its events.
 */
@Injectable(QueueMessageHook)
export class QueueAuditHook extends QueueMessageHook {
  public async beforeEmit(message: IQueueMessage): Promise<void> {
    const rule = messageRuleOf(message);
    if (!rule) return;

    // emit() keeps an id that is already set, so the recorded id is the one the message is sent with.
    message.MessageId ??= randomUUID();
    // 'attempt': the transport is called after this hook, the send itself is not seen.
    await audit().record(eventOf(message, 'queue.publish', 'attempt', details(message, rule)), optionsOf(rule));
  }

  public async aroundHandle<T>(message: IQueueMessage, next: () => Promise<T>): Promise<T> {
    const rule = messageRuleOf(message);
    if (!rule || failed.has(message)) return next();

    const options = optionsOf(rule);
    const rejecting = (rule.onFailure ?? trailConfig(rule.trail).onFailure) === 'reject';
    const base = details(message, rule);
    // The outcome of a handler that already ran cannot be refused any more, so it is never written with 'reject'.
    const afterwards: AuditWriteOptions = rejecting ? { ...options, mode: 'confirmed', onFailure: 'continue' } : options;
    const started = performance.now();
    const elapsed = (): number => Math.round((performance.now() - started) * 100) / 100;

    try {
      if (rejecting) {
        await audit().record(eventOf(message, rule.action, 'attempt', base), { ...options, mode: 'confirmed', onFailure: 'reject' });
      }
      const result = await next();
      await audit().record(eventOf(message, rule.action, 'ok', { ...base, ms: elapsed() }), afterwards);
      return result;
    } catch (error) {
      failed.add(message);
      // a failed attempt write is not a failure of the handler, which never ran
      if (!(error instanceof AuditWriteFailed)) {
        const outcome: AuditOutcome = isPermanentJobFailure(error) && error.reason === 'access_denied' ? 'denied' : 'failed';
        await audit().record(eventOf(message, rule.action, outcome, { ...base, ms: elapsed(), error: errorName(error) }), afterwards);
      }
      throw error;
    }
  }
}
