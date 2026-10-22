import { DI } from '@spinajs/di';
import { v4 as uuidv4 } from 'uuid';
import { SchedulerCancelCommand } from '../cli/SchedulerCancelCommand.js';
import { SchedulerErrorsCommand } from '../cli/SchedulerErrorsCommand.js';
import { SchedulerErrorsResolveCommand } from '../cli/SchedulerErrorsResolveCommand.js';
import { SchedulerListCommand } from '../cli/SchedulerListCommand.js';
import { SchedulerPauseCommand } from '../cli/SchedulerPauseCommand.js';
import { SchedulerPruneCommand } from '../cli/SchedulerPruneCommand.js';
import { SchedulerResumeCommand } from '../cli/SchedulerResumeCommand.js';
import { SchedulerRetryCommand } from '../cli/SchedulerRetryCommand.js';
import { SchedulerRunCommand } from '../cli/SchedulerRunCommand.js';
import { SchedulerRunsCommand } from '../cli/SchedulerRunsCommand.js';
import { SchedulerRunShowCommand } from '../cli/SchedulerRunShowCommand.js';
import { SchedulerShowCommand } from '../cli/SchedulerShowCommand.js';
import {
  ErrorGroupStatus,
  errorCodeFor,
  RunStatus,
  SchedulerErrorCode,
  SchedulerService,
  TriggeredBy,
} from '../contract.js';
import { defineSchedule, undefineSchedule } from '../decorators.js';
import type { ScheduleOptions } from '../interfaces.js';
import { ErrorGroupModel } from '../models/ErrorGroupModel.js';
import { RunModel } from '../models/RunModel.js';
import { ScheduledTask } from '../ScheduledTask.js';

/** One variant per `SchedulerService` method except `subscribe` (streams have their own checks). */
export type ParityAction =
  | { action: 'listSchedules' }
  | { action: 'getSchedule'; name: string }
  | { action: 'runNow'; name: string; params?: Record<string, unknown>; force?: boolean }
  | { action: 'listRuns'; schedule?: string; status?: RunStatus }
  | { action: 'getRun'; runId: string }
  | { action: 'cancel'; runId: string }
  | { action: 'retry'; runId: string; fromStep?: string; resume?: boolean }
  | { action: 'retryFailed'; name: string; since: string }
  | { action: 'pause'; name: string; hard?: boolean }
  | { action: 'resume'; name: string }
  | { action: 'listErrors'; schedule?: string; status?: ErrorGroupStatus }
  | { action: 'setErrorStatus'; fingerprint: string; status: ErrorGroupStatus }
  | { action: 'prune' };

export type ParityResult = { ok: true; value: unknown } | { ok: false; code: SchedulerErrorCode };

export interface ParityDriver {
  readonly name: string;
  invoke(action: ParityAction): Promise<ParityResult>;
}

export class ParityOkTask extends ScheduledTask {
  public execute(): Promise<unknown> {
    return Promise.resolve('ok');
  }
}

export class ParityFailTask extends ScheduledTask {
  public execute(): Promise<unknown> {
    return Promise.reject(new Error('parity failure'));
  }
}

const PARITY_OK_OPTIONS: ScheduleOptions = {
  manual: true,
  params: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
};

/** The schedules every parity host declares (`defineParitySchedules()`) before booting. */
export const PARITY_SCHEDULES = {
  ok: { name: 'parity-ok', task: ParityOkTask, options: PARITY_OK_OPTIONS },
  fail: { name: 'parity-fail', task: ParityFailTask, options: { manual: true } as ScheduleOptions },
} as const;

export function defineParitySchedules(): void {
  for (const s of Object.values(PARITY_SCHEDULES)) defineSchedule(s.task, s.name, s.options);
}

export function undefineParitySchedules(): void {
  for (const s of Object.values(PARITY_SCHEDULES)) undefineSchedule(s.name);
}

export function serviceParityDriver(
  service: SchedulerService,
  triggeredBy: TriggeredBy = { kind: 'system', id: 'parity' },
): ParityDriver {
  const ctx = { triggeredBy };
  const call = (a: ParityAction): Promise<unknown> => {
    switch (a.action) {
      case 'listSchedules':
        return service.listSchedules();
      case 'getSchedule':
        return service.getSchedule(a.name);
      case 'runNow':
        return service.runNow(a.name, { params: a.params, force: a.force, ...ctx });
      case 'listRuns':
        return service.listRuns({ schedule: a.schedule, status: a.status });
      case 'getRun':
        return service.getRun(a.runId);
      case 'cancel':
        return service.cancel(a.runId, ctx);
      case 'retry':
        return service.retry(a.runId, { fromStep: a.fromStep, resume: a.resume, ...ctx });
      case 'retryFailed':
        return service.retryFailed(a.name, a.since, ctx);
      case 'pause':
        return service.pause(a.name, { hard: a.hard, ...ctx });
      case 'resume':
        return service.resume(a.name, ctx);
      case 'listErrors':
        return service.listErrors({ schedule: a.schedule, status: a.status });
      case 'setErrorStatus':
        return service.setErrorStatus(a.fingerprint, a.status, ctx);
      case 'prune':
        return service.prune(ctx);
    }
  };
  return {
    name: 'service',
    invoke: async (a) => {
      try {
        // the other drivers can only ever return JSON
        return { ok: true, value: JSON.parse(JSON.stringify(await call(a))) as unknown };
      } catch (err) {
        return { ok: false, code: errorCodeFor(err) };
      }
    },
  };
}

const NO_JSON = Symbol('no-json');

/**
 * The command's document is the last one printed: a host logger writing to the console (an audit
 * line at info) prints before it. Pretty-printed JSON spans several lines.
 */
function lastJson(printed: string[]): unknown {
  const text = printed.join('\n').split('\n');
  for (let end = text.length - 1; end >= 0; end--) {
    if (!/[}\]]\s*$/.test(text.at(end) ?? '')) continue;
    for (let start = end; start >= 0; start--) {
      if (!/^\s*[{[]/.test(text.at(start) ?? '')) continue;
      try {
        return JSON.parse(text.slice(start, end + 1).join('\n')) as unknown;
      } catch {
        // not a whole document yet; widen it
      }
    }
  }
  return NO_JSON;
}

async function captureJson(action: ParityAction, fn: () => Promise<void>): Promise<unknown> {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  const exitCode = process.exitCode;
  console.log = (...a: unknown[]) => void lines.push(a.join(' '));
  console.error = () => undefined;
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = exitCode;
  }
  const out = lastJson(lines);
  if (out === NO_JSON) {
    throw new Error(`no JSON document in the CLI output of ${JSON.stringify(action)}:\n${lines.join('\n')}`);
  }
  return out;
}

type Executable = { execute(...args: never[]): Promise<void> };

/** Runs the real `scheduler:*` command classes with `--json`; a failure prints `{ error: { code } }`. */
export function cliParityDriver(): ParityDriver {
  const json = { json: true };
  const call = (a: ParityAction): Promise<unknown> => {
    const run = async (type: new () => Executable, ...args: unknown[]): Promise<unknown> => {
      const cmd = (await DI.resolve(type)) as unknown as { execute(...x: unknown[]): Promise<void> };
      return captureJson(a, () => cmd.execute(...args));
    };
    switch (a.action) {
      case 'listSchedules':
        return run(SchedulerListCommand, json);
      case 'getSchedule':
        return run(SchedulerShowCommand, a.name, json);
      case 'runNow':
        return run(SchedulerRunCommand, a.name, {
          ...json,
          params: a.params ? JSON.stringify(a.params) : undefined,
          param: [],
          force: a.force,
        });
      case 'listRuns':
        return run(SchedulerRunsCommand, a.schedule, { ...json, status: a.status });
      case 'getRun':
        return run(SchedulerRunShowCommand, a.runId, json);
      case 'cancel':
        return run(SchedulerCancelCommand, a.runId, json);
      case 'retry':
        return run(SchedulerRetryCommand, a.runId, { ...json, fromStep: a.fromStep, resume: a.resume, param: [] });
      case 'retryFailed':
        return run(SchedulerRetryCommand, undefined, { ...json, schedule: a.name, failedSince: a.since, param: [] });
      case 'pause':
        return run(SchedulerPauseCommand, a.name, { ...json, hard: a.hard });
      case 'resume':
        return run(SchedulerResumeCommand, a.name, json);
      case 'listErrors':
        return run(SchedulerErrorsCommand, a.schedule, { ...json, status: a.status });
      case 'setErrorStatus':
        return run(SchedulerErrorsResolveCommand, a.fingerprint, { ...json, status: a.status });
      case 'prune':
        return run(SchedulerPruneCommand, json);
    }
  };
  return {
    name: 'cli',
    invoke: async (a) => {
      const out = (await call(a)) as { error?: { code: SchedulerErrorCode } } | null;
      return out && typeof out === 'object' && 'error' in out && out.error
        ? { ok: false, code: out.error.code }
        : { ok: true, value: out };
    },
  };
}

const VOLATILE = new Set([
  'id',
  'runId',
  'runIds',
  'parentRunId',
  'lastRunId',
  'createdAt',
  'startedAt',
  'finishedAt',
  'updatedAt',
  'scheduledAt',
  'nextRunAt',
  'nextAttemptAt',
  'lastSuccessAt',
  'firstSeen',
  'lastSeen',
  'occurredAt',
  'ts',
  'durationMs',
  'stack',
  'sampleStack',
  'triggeredBy',
  'jobId',
]);

const volatile = (v: unknown): unknown => (Array.isArray(v) ? v.map(() => '<v>') : '<v>');

/**
 * Replaces ids, timestamps, durations, stacks and `triggeredBy` with `'<v>'`, at any depth. An array
 * of ids (`runIds`) keeps its length.
 */
export function normalizeForParity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForParity);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        VOLATILE.has(k) ? volatile(v) : normalizeForParity(v),
      ]),
    );
  }
  return value;
}

export interface ParityCase {
  title: string;
  arrange?: (service: SchedulerService) => Promise<Record<string, string>>;
  act: (vars: Record<string, string>) => ParityAction;
  expect: 'ok' | SchedulerErrorCode;
}

const by: TriggeredBy = { kind: 'system', id: 'parity-arrange' };
// well-formed: scheduler-http rejects a malformed id with 400 before the service is called
const UNKNOWN_RUN_ID = '00000000-0000-4000-8000-000000000000';
const OK = PARITY_SCHEDULES.ok.name;
const FAIL = PARITY_SCHEDULES.fail.name;
const ARRANGED_AT = Date.parse('2026-01-05T09:00:00Z');

async function insertRun(schedule: string, status: RunStatus): Promise<string> {
  const id = uuidv4();
  const t = ARRANGED_AT;
  await RunModel.create({
    Id: id,
    Schedule: schedule,
    Trigger: 'manual',
    Status: status,
    Attempt: 1,
    MaxAttempts: 1,
    CreatedAt: t,
    StartedAt: t,
    FinishedAt: t + 1000,
    UpdatedAt: t + 1000,
    Progress: status === 'succeeded' ? 100 : 0,
    CancelRequested: false,
    Forced: false,
  });
  return id;
}

async function insertErrorGroup(): Promise<Record<string, string>> {
  await ErrorGroupModel.create({
    Schedule: FAIL,
    Fingerprint: 'parity-fp',
    Name: 'Error',
    SampleMessage: 'parity failure',
    Count: 1,
    FirstSeen: ARRANGED_AT,
    LastSeen: ARRANGED_AT,
    Status: 'open',
  });
  return {};
}

/**
 * Every case runs on fresh state (`reset()`, clock at 2026-01-05T10:00:00Z). No case passes a status
 * the CLI does not know: `--status` typos are rejected by the CLI only.
 */
export const PARITY_CASES: ParityCase[] = [
  { title: 'list schedules', act: () => ({ action: 'listSchedules' }), expect: 'ok' },
  { title: 'show a schedule', act: () => ({ action: 'getSchedule', name: OK }), expect: 'ok' },
  { title: 'show an unknown schedule', act: () => ({ action: 'getSchedule', name: 'missing' }), expect: 'not-found' },
  {
    title: 'run now with valid params',
    act: () => ({ action: 'runNow', name: OK, params: { n: 1 } }),
    expect: 'ok',
  },
  {
    title: 'run now with invalid params',
    act: () => ({ action: 'runNow', name: OK, params: { n: 'x' } }),
    expect: 'invalid-params',
  },
  {
    title: 'run now while a run is queued',
    arrange: async (s) => ({ runId: (await s.runNow(FAIL, { triggeredBy: by })).runId }),
    act: () => ({ action: 'runNow', name: FAIL }),
    expect: 'conflict',
  },
  {
    title: 'run now on a hard-paused schedule',
    arrange: async (s) => {
      await s.pause(FAIL, { hard: true, triggeredBy: by });
      return {};
    },
    act: () => ({ action: 'runNow', name: FAIL }),
    expect: 'invalid-state',
  },
  {
    title: 'list runs',
    arrange: async () => ({ runId: await insertRun(FAIL, 'failed') }),
    act: () => ({ action: 'listRuns', schedule: FAIL, status: 'failed' }),
    expect: 'ok',
  },
  {
    title: 'show a run',
    arrange: async () => ({ runId: await insertRun(FAIL, 'failed') }),
    act: (v) => ({ action: 'getRun', runId: v.runId }),
    expect: 'ok',
  },
  {
    title: 'show an unknown run',
    act: () => ({ action: 'getRun', runId: UNKNOWN_RUN_ID }),
    expect: 'not-found',
  },
  {
    title: 'cancel a queued run',
    arrange: async (s) => ({ runId: (await s.runNow(FAIL, { triggeredBy: by })).runId }),
    act: (v) => ({ action: 'cancel', runId: v.runId }),
    expect: 'ok',
  },
  {
    title: 'cancel a finished run',
    arrange: async () => ({ runId: await insertRun(FAIL, 'succeeded') }),
    act: (v) => ({ action: 'cancel', runId: v.runId }),
    expect: 'invalid-state',
  },
  {
    title: 'cancel an unknown run',
    act: () => ({ action: 'cancel', runId: UNKNOWN_RUN_ID }),
    expect: 'not-found',
  },
  {
    title: 'retry a failed run',
    arrange: async () => ({ runId: await insertRun(FAIL, 'failed') }),
    act: (v) => ({ action: 'retry', runId: v.runId }),
    expect: 'ok',
  },
  {
    title: 'retry a succeeded run',
    arrange: async () => ({ runId: await insertRun(FAIL, 'succeeded') }),
    act: (v) => ({ action: 'retry', runId: v.runId }),
    expect: 'invalid-state',
  },
  {
    title: 'retry from an unknown step',
    arrange: async () => ({ runId: await insertRun(FAIL, 'failed') }),
    act: (v) => ({ action: 'retry', runId: v.runId, fromStep: 'nope' }),
    expect: 'invalid-params',
  },
  {
    title: 'retry failed runs since a time',
    arrange: async () => ({ runId: await insertRun(FAIL, 'failed') }),
    act: () => ({ action: 'retryFailed', name: FAIL, since: '2026-01-05T00:00:00Z' }),
    expect: 'ok',
  },
  {
    title: 'retry failed runs since an invalid time',
    act: () => ({ action: 'retryFailed', name: FAIL, since: 'yesterday-ish' }),
    expect: 'invalid-params',
  },
  { title: 'pause', act: () => ({ action: 'pause', name: OK }), expect: 'ok' },
  { title: 'pause an unknown schedule', act: () => ({ action: 'pause', name: 'missing' }), expect: 'not-found' },
  {
    title: 'resume',
    arrange: async (s) => {
      await s.pause(OK, { triggeredBy: by });
      return {};
    },
    act: () => ({ action: 'resume', name: OK }),
    expect: 'ok',
  },
  {
    title: 'list errors',
    arrange: insertErrorGroup,
    act: () => ({ action: 'listErrors', schedule: FAIL }),
    expect: 'ok',
  },
  {
    title: 'list open errors',
    arrange: insertErrorGroup,
    act: () => ({ action: 'listErrors', status: 'open' }),
    expect: 'ok',
  },
  {
    title: 'resolve an error group',
    arrange: insertErrorGroup,
    act: () => ({ action: 'setErrorStatus', fingerprint: 'parity-fp', status: 'resolved' }),
    expect: 'ok',
  },
  {
    title: 'resolve an unknown error group',
    act: () => ({ action: 'setErrorStatus', fingerprint: 'nope', status: 'resolved' }),
    expect: 'not-found',
  },
  { title: 'prune', act: () => ({ action: 'prune' }), expect: 'ok' },
];

export interface ParityOutcome {
  title: string;
  expect: string;
  results: Record<string, ParityResult>;
}

/**
 * Runs each case once per driver, each time on fresh state from `reset()`, and collects the normalized
 * results keyed by driver name. It never asserts: the host compares the drivers and `expect`.
 */
export async function runParityCases(o: {
  reset: () => Promise<SchedulerService>;
  drivers: (service: SchedulerService) => ParityDriver[];
  cases?: ParityCase[];
}): Promise<ParityOutcome[]> {
  const out: ParityOutcome[] = [];
  for (const c of o.cases ?? PARITY_CASES) {
    const results: Record<string, ParityResult> = {};
    let service = await o.reset();
    const count = o.drivers(service).length;
    for (let i = 0; i < count; i++) {
      if (i > 0) service = await o.reset();
      const driver = o.drivers(service).at(i) as ParityDriver;
      const vars = c.arrange ? await c.arrange(service) : {};
      const action = c.act(vars);
      let r: ParityResult;
      try {
        r = await driver.invoke(action);
      } catch (err) {
        throw new Error(`parity case '${c.title}', driver ${driver.name}: ${(err as Error).message}`, { cause: err });
      }
      results[driver.name] = r.ok ? { ok: true, value: normalizeForParity(r.value) } : r;
    }
    out.push({ title: c.title, expect: c.expect, results });
  }
  return out;
}
