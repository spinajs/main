import { createHash } from 'node:crypto';
import type { Decision, DecisionRequest } from '../contracts/decision.js';
import type { DecisionLog, DecisionRecord, DecisionTraceContext, PolicyHashSource } from '../contracts/decision-log.js';
import { principalKey } from '../contracts/principal.js';
import type { Principal } from '../contracts/principal.js';
import { resourceKey } from '../contracts/resource.js';
import { DecisionTap } from '../contracts/tap.js';
import type { DecisionReadSet } from '../contracts/tap.js';
import { principalState } from '../engine/cache-key.js';
import { newDecisionId } from '../engine/support/ids.js';
import { isObject } from '../engine/internal/util.js';
import { thrownError } from './log.js';
import type { AuthzLog } from './log.js';

export type DecisionLogMode = 'off' | 'deny' | 'sampled' | 'all';

export interface DecisionLogOptions {
  readonly domain: string;
  readonly sink: DecisionLog;
  readonly mode: DecisionLogMode;
  /** Share of allows `sampled` logs; denials are always logged. */
  readonly allowSampleRate: number;
  readonly captureInputs: boolean;
  readonly batch: { readonly size: number; readonly flushMs: number };
  readonly policy?: PolicyHashSource;
  readonly trace?: DecisionTraceContext;
  readonly log: Pick<AuthzLog, 'error'>;
  /** For tests. */
  readonly random?: () => number;
}

/** Feeds a DecisionLog from the engine's DecisionTap: one record per logged decision, written in batches. */
export class DecisionLogTap extends DecisionTap {
  private buffer: DecisionRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> = Promise.resolve();
  private readonly random: () => number;

  constructor(private readonly options: DecisionLogOptions) {
    super();
    this.random = options.random ?? Math.random;
  }

  /** `sampled` cannot tell an allow apart before it rolls, which onDecision does. */
  wants(decision: Decision): boolean {
    const mode = this.options.mode;
    return mode === 'all' || (mode !== 'off' && (!decision.allowed || (mode === 'sampled' && this.options.allowSampleRate > 0)));
  }

  onDecision(req: DecisionRequest, decision: Decision, reads: DecisionReadSet, meta: { cached: boolean; durationMs: number }): void {
    if (!this.logs(decision)) return;
    const id = decision.id ?? newDecisionId();
    const trace = this.options.trace;
    const record = this.record(id, req, decision, reads, meta.cached, trace?.current());
    trace?.annotate(id);
    this.buffer.push(record);
    if (this.buffer.length >= this.options.batch.size) void this.flush();
    else this.timer ??= unref(setTimeout(() => void this.flush(), this.options.batch.flushMs));
  }

  /** Writes what is buffered; resolves when every write started so far has settled. */
  flush(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const records = this.buffer;
    this.buffer = [];
    if (records.length > 0) this.pending = this.pending.then(() => this.write(records));
    return this.pending;
  }

  private async write(records: DecisionRecord[]): Promise<void> {
    try {
      await this.options.sink.write(records);
    } catch (e) {
      this.options.log.error({ error: thrownError(e), domain: this.options.domain, count: records.length }, 'Authz domain ${domain}: the decision log failed to write ${count} record(s); they are dropped');
    }
  }

  private logs(decision: Decision): boolean {
    switch (this.options.mode) {
      case 'all':
        return true;
      case 'deny':
        return !decision.allowed;
      case 'sampled':
        return !decision.allowed || this.random() < this.options.allowSampleRate;
      default:
        return false;
    }
  }

  private record(id: string, req: DecisionRequest, decision: Decision, reads: DecisionReadSet, cached: boolean, trace: { readonly traceId: string; readonly spanId: string } | undefined): DecisionRecord {
    const now = req.env?.now;
    const policyHash = this.options.policy?.policyHash(this.options.domain) ?? 'unknown';
    const record: DecisionRecord = {
      id,
      at: (now instanceof Date ? now : new Date()).toISOString(),
      domain: decision.domain,
      principal: principalKey(decision.principal),
      permission: decision.permission,
      resource: decision.resource,
      allowed: decision.allowed,
      cached,
      policyHash,
      modelVersions: reads.modelVersions,
      inputsHash: inputsHash(req, decision, reads, policyHash),
    };
    if (trace) Object.assign(record, { traceId: trace.traceId, spanId: trace.spanId });
    if (decision.actor) record.actor = principalKey(decision.actor);
    if (decision.reason) record.reason = decision.reason.code;
    if (this.options.captureInputs) record.inputs = { env: reads.env, attributes: reads.attributes, relations: reads.relations, modelVersions: reads.modelVersions };
    return record;
  }
}

function unref<T>(timer: T): T {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

/**
 * SHA-256 of what the decision read (G14): the principal's and actor's full state, the permission and resource, the env,
 * attribute and relation reads (sorted, so concurrent model reads hash alike), the model versions and the policy hash.
 */
export function inputsHash(req: DecisionRequest, decision: Decision, reads: DecisionReadSet, policyHash: string): string {
  const stateOf = (p: Principal | undefined) => (p === undefined ? null : (principalState(p) ?? principalKey(p)));
  const sortBy = <T>(xs: readonly T[], key: (x: T) => string) => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const refOf = (r: DecisionReadSet['attributes'][number]['ref']) => (typeof r === 'string' ? r : resourceKey(r));
  const inputs = {
    principal: isObject(req.principal) ? stateOf(req.principal) : principalKey(decision.principal),
    actor: stateOf(req.actor),
    permission: decision.permission,
    resource: resourceKey(decision.resource),
    env: reads.env,
    attributes: sortBy(reads.attributes, (a) => `${refOf(a.ref)}\u0000${a.path}`),
    relations: sortBy(reads.relations, (r) => `${r.model}\u0000${resourceKey(r.object)}\u0000${r.relation}`),
    modelVersions: reads.modelVersions,
    policyHash,
  };
  return createHash('sha256').update(canonical(inputs)).digest('hex');
}

/** JSON with sorted keys; Dates as ISO strings, anything JSON cannot hold as a tagged string, cycles cut. */
export function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(`<number:${String(value)}>`);
  if (value === undefined) return '"<undefined>"';
  if (typeof value !== 'object') return JSON.stringify(`<${typeof value}>`);
  if (value instanceof Date) return JSON.stringify(Number.isNaN(value.getTime()) ? '<invalid date>' : value.toISOString());
  if (seen.has(value)) return '"<cycle>"';
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((v: unknown) => canonical(v, seen)).join(',')}]`;
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k], seen)}`);
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}
