import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DI, Injectable } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import { QueueMessageHook, isJob, isPermanentJobFailure } from '@spinajs/queue';
import type { IQueueMessage } from '@spinajs/queue';

import { AUDIT_WIDTHS, audit, auditStore, trailConfig } from '../index.js';
import type { AuditInput, AuditOutcome, AuditWriteOptions } from '../index.js';
import { messageRuleOf } from './rules.js';
import type { MessageRule } from './rules.js';

// One execution per delivery: the onFailed pass of a failed job and the consume callback of a job reach aroundHandle again
// with the same message, which is a new object on every delivery (@Job and @Event are NewInstance).
const entered = new WeakSet<IQueueMessage>();

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

interface Writes {
  readonly options: AuditWriteOptions;
  readonly rejecting: boolean;
}

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

const outcomeOf = <T>(settled: Settled<T>): AuditOutcome => {
  if (settled.ok) return 'ok';
  return isPermanentJobFailure(settled.error) && settled.error.reason === 'access_denied' ? 'denied' : 'failed';
};

// The core refuses a subject id wider than its column, and the sender picks the MessageId: a long one is recorded by its digest.
const isLongId = (id: string | undefined): id is string => id !== undefined && id.length > AUDIT_WIDTHS.subject_id;

function details(message: IQueueMessage, rule: MessageRule): Record<string, unknown> {
  const fields = Object.fromEntries((rule.fields ?? []).map((field): [string, unknown] => [field, Reflect.get(message, field)]));
  const initiator = message.Initiator ? `${message.Initiator.type}:${message.Initiator.id}` : undefined;
  // On a publish emit() has not derived the JobId yet; it will take the MessageId, as here.
  const jobId = 'JobId' in message && typeof message.JobId === 'string' ? message.JobId : isJob(message) ? message.MessageId : undefined;

  return {
    message: message.Name,
    type: message.Type,
    ...(isLongId(message.MessageId) ? { messageId: message.MessageId } : {}),
    ...(jobId ? { jobId } : {}),
    ...(initiator ? { initiator } : {}),
    ...(rule.fields?.length ? { fields } : {}),
  };
}

function eventOf(message: IQueueMessage, action: string, outcome: AuditOutcome, data: Record<string, unknown>): AuditInput {
  const id = isLongId(message.MessageId) ? createHash('sha256').update(message.MessageId).digest('hex') : message.MessageId;
  const type = (message.Name || message.constructor.name).slice(0, AUDIT_WIDTHS.subject_type);
  return { kind: 'action', action, outcome, ...(id ? { subject: { type, id } } : {}), data };
}

/**
 * Records publishes and executions of message classes that carry `@Audited`. Hooks nest in registration order: import this
 * module after `@spinajs/authz-queue` and the job's principal is the actor of its events.
 */
@Injectable(QueueMessageHook)
export class QueueAuditHook extends QueueMessageHook {
  private logger: Log | undefined;

  public async beforeEmit(message: IQueueMessage): Promise<void> {
    const rule = messageRuleOf(message);
    if (!rule) return;

    const { options, rejecting } = await this.writes(rule);
    // emit() keeps an id that is already set, so the recorded id is the one the message is sent with.
    message.MessageId ??= randomUUID();
    // 'attempt': the transport is called after this hook, the send itself is not seen.
    await audit().record(eventOf(message, 'queue.publish', 'attempt', details(message, rule)), rejecting ? { ...options, mode: 'confirmed', onFailure: 'reject' } : options);
  }

  public async aroundHandle<T>(message: IQueueMessage, next: () => Promise<T>): Promise<T> {
    const rule = messageRuleOf(message);
    if (!rule || entered.has(message)) return next();
    entered.add(message);

    // Everything that can refuse an event is known before the handler runs, so it fails the delivery here, not after the job ran.
    const { options, rejecting } = await this.writes(rule);
    const base = details(message, rule);
    if (rejecting) {
      await audit().record(eventOf(message, rule.action, 'attempt', base), { ...options, mode: 'confirmed', onFailure: 'reject' });
    }

    const started = performance.now();
    let settled: Settled<T>;
    try {
      settled = { ok: true, value: await next() };
    } catch (error) {
      settled = { ok: false, error };
    }

    const ms = Math.round((performance.now() - started) * 100) / 100;
    const outcome = outcomeOf(settled);
    const data = { ...base, ms, ...(settled.ok ? {} : { error: errorName(settled.error) }) };
    // The handler already ran: a refused outcome cannot undo it, and throwing would make the queue run it again.
    await this.outcome(message, eventOf(message, rule.action, outcome, data), rejecting ? { ...options, mode: 'confirmed', onFailure: 'continue' } : options);

    if (!settled.ok) throw settled.error;
    return settled.value;
  }

  protected log(): Pick<Log, 'error'> {
    return (this.logger ??= DI.resolve(Log, ['audit-queue']));
  }

  private async writes(rule: MessageRule): Promise<Writes> {
    const trail = trailConfig(rule.trail);
    await auditStore(trail);
    return { options: optionsOf(rule), rejecting: (rule.onFailure ?? trail.onFailure) === 'reject' };
  }

  private async outcome(message: IQueueMessage, event: AuditInput, options: AuditWriteOptions): Promise<void> {
    try {
      await audit().record(event, options);
    } catch (error) {
      try {
        this.log().error({ error, messageName: message.Name, messageId: message.MessageId, outcome: event.outcome }, 'audit: the ${outcome} event of message ${messageName} ${messageId} was not recorded');
      } catch {
        // A logger that fails must not fail the job either: the queue would run it again.
      }
    }
  }
}
