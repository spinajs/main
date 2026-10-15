import { createHash } from 'crypto';
import type { Constructor } from '@spinajs/di';
import { parseDuration } from '../time/duration.js';
import { parseSpec } from '../time/spec.js';
import { ScheduleValidationError } from '../errors.js';
import { ScheduledTask } from '../ScheduledTask.js';
import type { ScheduleDeclaration } from '../decorators.js';
import type { ConfigScheduleEntry, MisfirePolicy, NormalizedRetry, ScheduleDefinition, ScheduleOptions } from '../interfaces.js';

export interface BuildDefinitionsInput {
  declarations: ScheduleDeclaration[];
  config: ConfigScheduleEntry[];
  tickMs: number;
  validateParamsSchema: (schema: object) => string | null;
}

const SPEC_KEYS = ['cron', 'every', 'at', 'manual'] as const;

interface Candidate {
  options: ScheduleOptions;
  target: Constructor<ScheduledTask>;
  source: ScheduleDefinition['source'];
}

function mergeOptions(base: ScheduleOptions, override: Omit<ConfigScheduleEntry, 'name' | 'task'>): ScheduleOptions {
  const overridesSpec = SPEC_KEYS.some((k) => override[k] !== undefined);
  const kept = { ...base };
  if (overridesSpec) for (const k of SPEC_KEYS) delete kept[k];
  return { ...kept, ...(override as ScheduleOptions) };
}

function parseMisfire(value: string, name: string): MisfirePolicy {
  if (value === 'skip' || value === 'run-once') return { kind: value };
  const m = /^catch-up\((\d+)\)$/.exec(value);
  if (m && Number(m[1]) >= 1) return { kind: 'catch-up', max: Number(m[1]) };
  throw new Error(`schedule '${name}': misfire must be skip, run-once or catch-up(n) with n >= 1 (got '${value}')`);
}

function normalizeRetry(o: ScheduleOptions['retry'], name: string): NormalizedRetry | undefined {
  if (!o) return undefined;
  if (!Number.isInteger(o.attempts) || o.attempts < 1) throw new Error(`schedule '${name}': retry.attempts must be an integer >= 1`);
  const backoff = o.backoff ?? 'fixed';
  if (backoff !== 'fixed' && backoff !== 'exponential') throw new Error(`schedule '${name}': retry.backoff must be fixed or exponential`);
  const delayMs = parseDuration(o.delay ?? '1m', `schedule '${name}' retry.delay`);
  const maxDelayMs = parseDuration(o.maxDelay ?? Math.max(delayMs, 3_600_000), `schedule '${name}' retry.maxDelay`);
  return { attempts: o.attempts, backoff, delayMs, maxDelayMs, retryOn: o.retryOn };
}

function normalize(name: string, c: Candidate, input: BuildDefinitionsInput): ScheduleDefinition {
  const o = c.options;
  const spec = parseSpec(o, name);
  const overlap = o.overlap ?? 'skip';
  if (overlap !== 'skip' && overlap !== 'queue') throw new Error(`schedule '${name}': overlap must be skip or queue`);
  const runOn = o.runOn ?? 'leader';
  if (runOn !== 'leader' && runOn !== 'all') throw new Error(`schedule '${name}': runOn must be leader or all`);
  if (o.emit && runOn === 'all') throw new Error(`schedule '${name}': emit cannot be combined with runOn: all`);
  if (o.params) {
    const problem = input.validateParamsSchema(o.params);
    if (problem) throw new Error(`schedule '${name}': invalid params schema: ${problem}`);
  }
  if (o.pauseAfterFailures !== undefined && (!Number.isInteger(o.pauseAfterFailures) || o.pauseAfterFailures < 1)) {
    throw new Error(`schedule '${name}': pauseAfterFailures must be an integer >= 1`);
  }

  return {
    name,
    spec,
    jitterMs: o.jitter !== undefined ? parseDuration(o.jitter, `schedule '${name}' jitter`) : 0,
    misfire: parseMisfire(o.misfire ?? 'run-once', name),
    misfireThresholdMs: o.misfireThreshold !== undefined ? parseDuration(o.misfireThreshold, `schedule '${name}' misfireThreshold`) : Math.max(input.tickMs * 2, 5000),
    overlap,
    runOn,
    emit: o.emit,
    paramsSchema: o.params,
    retry: normalizeRetry(o.retry, name),
    resumable: o.resumable ?? false,
    timeoutMs: o.timeout !== undefined ? parseDuration(o.timeout, `schedule '${name}' timeout`) : undefined,
    pauseAfterFailures: o.pauseAfterFailures,
    enabled: o.enabled ?? true,
    task: c.target,
    source: c.source,
  };
}

export function buildDefinitions(input: BuildDefinitionsInput): ScheduleDefinition[] {
  const problems: string[] = [];
  const candidates = new Map<string, Candidate>();
  const byClass = new Map<string, ScheduleDeclaration>();

  for (const d of input.declarations) {
    if (!(d.target.prototype instanceof ScheduledTask)) {
      problems.push(`schedule '${d.name}': ${d.target.name} must extend ScheduledTask`);
      continue;
    }
    const existing = candidates.get(d.name);
    if (existing) {
      problems.push(`duplicate schedule name '${d.name}' (${existing.target.name} and ${d.target.name})`);
      continue;
    }
    candidates.set(d.name, { options: d.options, target: d.target, source: d.source ?? 'decorator' });
    if (!byClass.has(d.target.name)) byClass.set(d.target.name, d);
  }

  const seen = new Set<string>();
  for (const entry of input.config) {
    const { name, task, ...override } = entry;
    if (seen.has(name)) {
      problems.push(`duplicate config schedule '${name}'`);
      continue;
    }
    seen.add(name);

    const base = candidates.get(name);
    let target = base?.target;
    let baseOptions = base?.options ?? {};
    if (task) {
      const t = byClass.get(task);
      if (!t) {
        problems.push(`schedule '${name}': unknown task '${task}' (no @Schedule class or @Task with this name)`);
        continue;
      }
      target = t.target;
      if (!base) baseOptions = t.options;
    }
    if (!target) {
      problems.push(`schedule '${name}': no @Schedule class with this name and no task given`);
      continue;
    }
    candidates.set(name, { options: mergeOptions(baseOptions, override), target, source: 'config' });
  }

  const defs: ScheduleDefinition[] = [];
  for (const [name, c] of candidates) {
    try {
      defs.push(normalize(name, c, input));
    } catch (err) {
      problems.push((err as Error).message);
    }
  }

  if (problems.length) throw new ScheduleValidationError(problems);
  return defs.sort((a, b) => a.name.localeCompare(b.name));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function serializeDefinition(def: ScheduleDefinition): Record<string, unknown> {
  return {
    name: def.name,
    spec: def.spec,
    jitterMs: def.jitterMs,
    misfire: def.misfire,
    misfireThresholdMs: def.misfireThresholdMs,
    overlap: def.overlap,
    runOn: def.runOn,
    emit: def.emit?.name ?? null,
    paramsSchema: def.paramsSchema ?? null,
    retry: def.retry ? { attempts: def.retry.attempts, backoff: def.retry.backoff, delayMs: def.retry.delayMs, maxDelayMs: def.retry.maxDelayMs, retryOn: !!def.retry.retryOn } : null,
    resumable: def.resumable,
    timeoutMs: def.timeoutMs ?? null,
    pauseAfterFailures: def.pauseAfterFailures ?? null,
    enabled: def.enabled,
    task: def.task.name,
    source: def.source,
  };
}

export function definitionHash(def: ScheduleDefinition): string {
  return createHash('sha256').update(stableStringify(serializeDefinition(def))).digest('hex');
}

/** The part of a definition that decides when it fires; a change resets NextRunAt. */
export function timingKey(serialized: Record<string, unknown>): string {
  const { spec, jitterMs, enabled, runOn } = serialized;
  return stableStringify({ spec, jitterMs, enabled, runOn });
}
