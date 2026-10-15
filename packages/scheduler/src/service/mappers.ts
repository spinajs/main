import { InvalidRunParams } from '../contract.js';
import type {
  AttemptInfo,
  ErrorGroupInfo,
  ParamError,
  RunInfo,
  RunSummary,
  ScheduleInfo,
  StepInfo,
} from '../contract.js';
import type { ScheduleDefinition } from '../interfaces.js';
import type { ErrorGroupModel } from '../models/ErrorGroupModel.js';
import type { RunAttemptModel } from '../models/RunAttemptModel.js';
import type { RunModel } from '../models/RunModel.js';
import type { RunStepModel } from '../models/RunStepModel.js';
import type { ScheduleModel } from '../models/ScheduleModel.js';
import { iso } from '../run/events.js';
import { describeSpec, type ScheduleSpec } from '../time/spec.js';
import { healthOf } from '../tracking/HealthTracker.js';

export const toArray = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

/** `field` names the request field in the error path (`/from`, `/since`). */
export function toMs(v: string | Date, field: string): number {
  const ms = typeof v === 'string' ? Date.parse(v) : v instanceof Date ? v.getTime() : NaN;
  if (Number.isNaN(ms)) {
    throw new InvalidRunParams(`invalid date '${String(v)}' for ${field}`, [
      { path: `/${field}`, message: 'expected an ISO-8601 date' },
    ]);
  }
  return ms;
}

/** For NOT NULL time columns. */
export function isoRequired(ms: number): string {
  return new Date(ms).toISOString();
}

/** The subset of an ajv `ErrorObject` the mapping reads. */
export interface SchemaErrorLike {
  instancePath?: string;
  keyword: string;
  message?: string;
  params?: Record<string, unknown>;
}

/** ajv errors as `ParamError`s; the validation config turns ajv messages off, so they are built here. */
export function toParamErrors(errors: SchemaErrorLike[]): ParamError[] {
  return errors.map((e) => {
    const p = e.params ?? {};
    const child = (p.missingProperty ?? p.additionalProperty ?? p.unevaluatedProperty) as string | undefined;
    const path = `${e.instancePath ?? ''}${child !== undefined ? `/${child}` : ''}`;
    return { path, message: e.message ?? describeSchemaError(e.keyword, p) };
  });
}

function describeSchemaError(keyword: string, p: Record<string, unknown>): string {
  switch (keyword) {
    case 'required':
      return 'is required';
    case 'additionalProperties':
    case 'unevaluatedProperties':
      return 'is not allowed';
    case 'type':
      return `must be ${String(p.type)}`;
    case 'enum':
      return `must be one of ${JSON.stringify(p.allowedValues)}`;
    case 'const':
      return `must be ${JSON.stringify(p.allowedValue)}`;
    case 'format':
      return `must match format '${String(p.format)}'`;
    default:
      return Object.keys(p).length ? `must satisfy '${keyword}' ${JSON.stringify(p)}` : `must satisfy '${keyword}'`;
  }
}

export function toRunSummary(r: RunModel): RunSummary {
  return {
    id: r.Id,
    status: r.Status,
    trigger: r.Trigger,
    progress: r.Progress ?? 0,
    startedAt: iso(r.StartedAt),
    finishedAt: iso(r.FinishedAt),
  };
}

export function toRunInfo(r: RunModel, now: number, leaseTtl: number): RunInfo {
  return {
    id: r.Id,
    schedule: r.Schedule,
    trigger: r.Trigger,
    triggeredBy: r.TriggeredBy ?? null,
    parentRunId: r.ParentRunId ?? null,
    params: r.Params ?? null,
    status: r.Status,
    reason: r.Reason ?? null,
    attempt: r.Attempt,
    maxAttempts: r.MaxAttempts,
    nextAttemptAt: iso(r.NextAttemptAt),
    scheduledAt: iso(r.ScheduledAt),
    createdAt: isoRequired(r.CreatedAt),
    startedAt: iso(r.StartedAt),
    finishedAt: iso(r.FinishedAt),
    updatedAt: iso(r.UpdatedAt),
    durationMs: r.StartedAt && r.FinishedAt ? r.FinishedAt - r.StartedAt : null,
    progress: r.Progress ?? 0,
    currentStep: r.CurrentStep ?? null,
    message: r.Message ?? null,
    result: r.Result ?? null,
    error: r.Error ?? null,
    jobId: r.JobId ?? null,
    cancelRequested: !!r.CancelRequested,
    stale: r.Status === 'running' && !!r.UpdatedAt && now - r.UpdatedAt > leaseTtl,
  };
}

export function toStepInfo(s: RunStepModel): StepInfo {
  return {
    attempt: s.Attempt,
    seq: s.Seq,
    name: s.Name,
    status: s.Status,
    startedAt: isoRequired(s.StartedAt),
    finishedAt: iso(s.FinishedAt),
    durationMs: s.FinishedAt ? s.FinishedAt - s.StartedAt : null,
    progress: s.Progress ?? 0,
    done: s.Done ?? null,
    total: s.Total ?? null,
    message: s.Message ?? null,
    error: s.Error ?? null,
  };
}

export function toAttemptInfo(a: RunAttemptModel): AttemptInfo {
  return {
    attempt: a.Attempt,
    status: a.Status,
    startedAt: isoRequired(a.StartedAt),
    finishedAt: iso(a.FinishedAt),
    error: a.Error ?? null,
  };
}

export function toErrorGroupInfo(g: ErrorGroupModel): ErrorGroupInfo {
  return {
    schedule: g.Schedule,
    fingerprint: g.Fingerprint,
    name: g.Name,
    sampleMessage: g.SampleMessage,
    sampleStack: g.SampleStack ?? null,
    count: Number(g.Count),
    firstSeen: isoRequired(g.FirstSeen),
    lastSeen: isoRequired(g.LastSeen),
    lastRunId: g.LastRunId ?? null,
    status: g.Status,
  };
}

const MANUAL_SPEC: ScheduleSpec = { kind: 'manual', expression: 'manual', timezone: 'UTC' };

/**
 * `def` is absent for an orphaned schedule (no definition in this process); its stored definition
 * (`serializeDefinition`) still describes it.
 */
export function toScheduleInfo(
  row: ScheduleModel,
  def: ScheduleDefinition | undefined,
  lastRun: RunModel | null,
  now: number,
): ScheduleInfo {
  const stored = (row.Definition ?? {}) as {
    spec?: ScheduleSpec;
    runOn?: 'leader' | 'all';
    emit?: string | null;
    paramsSchema?: object | null;
  };
  const failures = Number(row.ConsecutiveFailures ?? 0);
  return {
    name: row.Name,
    spec: describeSpec(def?.spec ?? stored.spec ?? MANUAL_SPEC),
    runOn: def?.runOn ?? stored.runOn ?? 'leader',
    mode: (def ? !!def.emit : !!stored.emit) ? 'emit' : 'inline',
    enabled: def?.enabled ?? false,
    paused: !!row.Paused,
    pausedReason: row.PausedReason ?? null,
    hardPaused: !!row.HardPaused,
    nextRunAt: iso(row.NextRunAt),
    health: healthOf({ Paused: !!row.Paused, PausedReason: row.PausedReason ?? null, ConsecutiveFailures: failures }),
    consecutiveFailures: failures,
    lastSuccessAt: iso(row.LastSuccessAt),
    lastRun: lastRun ? toRunSummary(lastRun) : null,
    running: lastRun?.Status === 'running' || (!!row.LeaseOwner && (row.LeaseUntil ?? 0) > now),
    orphaned: !!row.Orphaned,
    paramsSchema: (def ? def.paramsSchema : stored.paramsSchema) ?? null,
  };
}
