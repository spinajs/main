import { parseDuration, type NormalizedRetry } from '@spinajs/durable';
import { InvalidArgument } from '@spinajs/exceptions';

export type OutboxMode = 'when-in-transaction' | 'always';

export interface IQueueOutboxBackoff {
  backoff?: 'fixed' | 'exponential';
  delay?: number | string;
  maxDelay?: number | string;
}

export interface IQueueOutboxConfig {
  enabled: boolean;
  /** Whether this process runs the relay loop; emit-only replicas and the simulation set false. */
  relay: boolean;
  connections: string[];
  mode: OutboxMode;
  tick: number;
  batchSize: number;
  claimTtl: number;
  /** How long one publish is expected to take at most; a batch stops before a row its claim can no longer cover. Not a timeout. */
  maxPublishMs: number;
  /** A row whose publish fails once it is this old (since CreatedAt) becomes `dead`; younger rows are retried. */
  maxAge: string | number;
  backoff: IQueueOutboxBackoff;
  retention: string | number;
}

export const OUTBOX_DEFAULTS: IQueueOutboxConfig = {
  enabled: false,
  relay: true,
  connections: ['default'],
  mode: 'when-in-transaction',
  tick: 1000,
  batchSize: 100,
  claimTtl: 30_000,
  maxPublishMs: 10_000,
  maxAge: '24h',
  backoff: { backoff: 'exponential', delay: '1s', maxDelay: '5m' },
  retention: '7d',
};

/** Fills the defaults. Only an enabled outbox is validated: a disabled one must not fail the Orm boot through the migration source. */
export function outboxConfig(raw: Partial<IQueueOutboxConfig> | undefined): IQueueOutboxConfig {
  const config: IQueueOutboxConfig = { ...OUTBOX_DEFAULTS, ...raw, backoff: { ...OUTBOX_DEFAULTS.backoff, ...raw?.backoff } };
  if (!config.enabled) return config;
  if (config.connections.length === 0) {
    throw new InvalidArgument('queue.outbox.connections must name at least one ORM connection');
  }
  if (config.maxPublishMs >= config.claimTtl) {
    throw new InvalidArgument(`queue.outbox.maxPublishMs (${config.maxPublishMs}) must be below claimTtl (${config.claimTtl})`);
  }
  parseDuration(config.retention, 'queue.outbox.retention');
  if (parseDuration(config.maxAge, 'queue.outbox.maxAge') <= 0) {
    throw new InvalidArgument('queue.outbox.maxAge must be above 0');
  }
  return config;
}

export function outboxRetry(config: IQueueOutboxConfig): NormalizedRetry {
  return {
    // rows die by age (maxAge), never by attempt count
    attempts: Number.POSITIVE_INFINITY,
    backoff: config.backoff.backoff ?? 'exponential',
    delayMs: parseDuration(config.backoff.delay ?? '1s', 'queue.outbox.backoff.delay'),
    maxDelayMs: parseDuration(config.backoff.maxDelay ?? '5m', 'queue.outbox.backoff.maxDelay'),
  };
}
