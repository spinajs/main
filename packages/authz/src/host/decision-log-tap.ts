import { createHash } from 'node:crypto';
import { activeTraceIds } from '@spinajs/tracing';
import type { Decision, DecisionRequest } from '../contracts/decision.js';
import type { CapturedInputs, DecisionLog, DecisionRecord, DecisionTraceContext, PolicyHashSource } from '../contracts/decision-log.js';
import type { Permission } from '../contracts/permission.js';
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
import { principalFacts } from './principal-facts.js';
import { ambientTraceId } from './storage.js';

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

  get policy(): PolicyHashSource | undefined {
    return this.options.policy;
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
    const record = this.record(id, req, decision, reads, meta, traceOf(trace));
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

  private record(id: string, req: DecisionRequest, decision: Decision, reads: DecisionReadSet, { cached, durationMs }: { cached: boolean; durationMs: number }, trace: { traceId: string; spanId?: string } | undefined): DecisionRecord {
    const now = req.env?.now;
    const loggedAt = new Date();
    const policyHash = this.options.policy?.policyHash(this.options.domain) ?? 'unknown';
    const parts = inputsHashParts(req, decision, reads, policyHash);
    const record: DecisionRecord = {
      id,
      at: (now instanceof Date ? now : loggedAt).toISOString(),
      loggedAt: loggedAt.toISOString(),
      durationMs,
      domain: decision.domain,
      principal: principalKey(decision.principal),
      permission: decision.permission,
      resource: decision.resource,
      allowed: decision.allowed,
      cached,
      policyHash,
      modelVersions: reads.modelVersions,
      inputsHash: inputsHashOf(parts),
    };
    if (trace) Object.assign(record, trace);
    if (decision.actor) record.actor = principalKey(decision.actor);
    if (decision.reason) record.reason = decision.reason.code;
    const facts = factsOf(req);
    if (facts) record.facts = facts;
    if (this.options.captureInputs) record.inputs = capturedInputs(reads, parts);
    return record;
  }
}

/**
 * The capture as the JSON `canonical()` hashed: `undefined`, non-finite numbers, bigints and Dates become the strings
 * it hashes them as. A sink that stores the capture as JSON then keeps `inputsHash` recomputable from it, which a
 * plain `JSON.stringify` would not (it drops `undefined`, writes `NaN` as null and throws on a bigint).
 */
function capturedInputs(reads: DecisionReadSet, parts: InputsHashParts): CapturedInputs {
  const capture = { env: reads.env, attributes: reads.attributes, relations: reads.relations, modelVersions: reads.modelVersions, principalState: parts.principal, actorState: parts.actor };
  return JSON.parse(canonical(capture)) as CapturedInputs;
}

function unref<T>(timer: T): T {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

/** All or nothing: with the principal's facts but not the actor's, a replay would see the actor without its ceiling and delegation. */
function factsOf(req: DecisionRequest): DecisionRecord['facts'] {
  const principal = isObject(req.principal) ? principalFacts(req.principal) : undefined;
  if (principal === undefined) return undefined;
  if (req.actor === undefined) return { principal };
  const actor = principalFacts(req.actor);
  return actor === undefined ? undefined : { principal, actor };
}

/**
 * The trace of a registered DecisionTraceContext; else the request store's trace id (the one changelog rows get) or,
 * outside a request, the active span's, with the active span's id when it belongs to that trace.
 */
function traceOf(context: DecisionTraceContext | undefined): { traceId: string; spanId?: string } | undefined {
  const given = context?.current();
  if (given) return { traceId: given.traceId, spanId: given.spanId };
  const active = activeTraceIds();
  const traceId = ambientTraceId() ?? active?.traceId;
  if (traceId === undefined) return undefined;
  return active?.traceId === traceId ? { traceId, spanId: active.spanId } : { traceId };
}

/** What `inputsHash` hashes, before its reads are sorted. */
export interface InputsHashParts {
  principal: string | null;
  actor: string | null;
  permission: Permission;
  /** resourceKey() */
  resource: string;
  env: Record<string, unknown>;
  attributes: DecisionReadSet['attributes'];
  relations: DecisionReadSet['relations'];
  modelVersions: Record<string, string>;
  policyHash: string;
}

export function inputsHashParts(req: DecisionRequest, decision: Decision, reads: DecisionReadSet, policyHash: string): InputsHashParts {
  const stateOf = (p: Principal | undefined) => (p === undefined ? null : (principalState(p) ?? principalKey(p)));
  return {
    principal: isObject(req.principal) ? stateOf(req.principal) : principalKey(decision.principal),
    actor: stateOf(req.actor),
    permission: decision.permission,
    resource: resourceKey(decision.resource),
    env: reads.env,
    attributes: reads.attributes,
    relations: reads.relations,
    modelVersions: reads.modelVersions,
    policyHash,
  };
}

/** Sorts the attribute and relation reads, so concurrent model reads hash alike, and hashes the canonical JSON. */
export function inputsHashOf(parts: InputsHashParts): string {
  const sortBy = <T>(xs: readonly T[], key: (x: T) => string) => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const refOf = (r: DecisionReadSet['attributes'][number]['ref']) => (typeof r === 'string' ? r : resourceKey(r));
  // Named one by one: a wider object passed as the parts must not add its other keys to the hash.
  const inputs = {
    principal: parts.principal,
    actor: parts.actor,
    permission: parts.permission,
    resource: parts.resource,
    env: parts.env,
    modelVersions: parts.modelVersions,
    policyHash: parts.policyHash,
    attributes: sortBy(parts.attributes, (a) => `${refOf(a.ref)}\u0000${a.path}`),
    relations: sortBy(parts.relations, (r) => `${r.model}\u0000${resourceKey(r.object)}\u0000${r.relation}`),
  };
  return createHash('sha256').update(canonical(inputs)).digest('hex');
}

/**
 * SHA-256 of what the decision read (G14): the principal's and actor's full state, the permission and resource, the env,
 * attribute and relation reads, the model versions and the policy hash.
 */
export function inputsHash(req: DecisionRequest, decision: Decision, reads: DecisionReadSet, policyHash: string): string {
  return inputsHashOf(inputsHashParts(req, decision, reads, policyHash));
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
