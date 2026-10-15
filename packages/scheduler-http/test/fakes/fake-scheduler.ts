import {
  ActionContext,
  ErrorFilter,
  ErrorGroupInfo,
  ErrorGroupNotFound,
  ErrorGroupStatus,
  Page,
  PauseOptions,
  PruneResult,
  RetryOptions,
  RunDetail,
  RunEvent,
  RunEventListener,
  RunFilter,
  RunInfo,
  RunNotFound,
  RunNowOptions,
  RunNowResult,
  RunStatus,
  ScheduleDetail,
  ScheduleInfo,
  ScheduleNotFound,
  SchedulerService,
  SubscribeOptions,
  SubscribeTarget,
  Unsubscribe,
} from '@spinajs/scheduler';

export const SCHEDULE_NAME = 'reconciler';
export const RUN_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_RUN_ID = '22222222-2222-4222-8222-222222222222';
export const TS = '2026-10-15T08:00:00.000Z';

export function makeSchedule(overrides: Partial<ScheduleInfo> = {}): ScheduleInfo {
  return {
    name: SCHEDULE_NAME,
    spec: { kind: 'every', expression: '5m', timezone: 'UTC' },
    runOn: 'leader',
    mode: 'inline',
    enabled: true,
    paused: false,
    pausedReason: null,
    hardPaused: false,
    nextRunAt: TS,
    health: 'ok',
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastRun: null,
    running: false,
    orphaned: false,
    paramsSchema: null,
    ...overrides,
  };
}

export function makeRun(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    id: RUN_ID,
    schedule: SCHEDULE_NAME,
    trigger: 'manual',
    triggeredBy: null,
    parentRunId: null,
    params: null,
    status: 'running',
    reason: null,
    attempt: 1,
    maxAttempts: 1,
    nextAttemptAt: null,
    scheduledAt: TS,
    createdAt: TS,
    startedAt: TS,
    finishedAt: null,
    updatedAt: TS,
    durationMs: null,
    progress: 40,
    currentStep: 'load',
    message: null,
    result: null,
    error: null,
    jobId: null,
    cancelRequested: false,
    stale: false,
    attempts: [],
    steps: [],
    logs: [],
    checkpoint: null,
    ...overrides,
  };
}

export function makeErrorGroup(overrides: Partial<ErrorGroupInfo> = {}): ErrorGroupInfo {
  return {
    schedule: SCHEDULE_NAME,
    fingerprint: 'f00dfeed',
    name: 'TypeError',
    sampleMessage: 'cannot read <prop> of undefined',
    sampleStack: null,
    count: 3,
    firstSeen: TS,
    lastSeen: TS,
    lastRunId: RUN_ID,
    status: 'open',
    ...overrides,
  };
}

const identity = (seq: number, runId: string, id: number) => ({ id, seq, runId, schedule: SCHEDULE_NAME, attempt: 1, ts: TS });

export function statusEvent(seq: number, status: RunStatus, runId = RUN_ID, id = seq): Extract<RunEvent, { type: 'status' }> {
  return { ...identity(seq, runId, id), type: 'status', status, reason: null };
}

export function stepStartEvent(seq: number, step: string, runId = RUN_ID, id = seq): RunEvent {
  return { ...identity(seq, runId, id), type: 'step-start', step, stepSeq: 1 };
}

export function progressEvent(seq: number, progress: number, runId = RUN_ID, id = seq): Extract<RunEvent, { type: 'progress' }> {
  return { ...identity(seq, runId, id), type: 'progress', progress, step: null, stepProgress: null };
}

interface ISubscription {
  matches: (event: RunEvent) => boolean;
  listener: RunEventListener;
}

/**
 * In-memory SchedulerService. Records every call, throws `failWith` once from the next call,
 * keeps emitted events for replay and delivers them to matching subscribers.
 */
export class FakeSchedulerService extends SchedulerService {
  public schedules: ScheduleInfo[] = [];
  public runs = new Map<string, RunDetail>();
  public events: RunEvent[] = [];
  public errors: ErrorGroupInfo[] = [];
  public calls: Array<{ method: string; args: unknown[] }> = [];
  public failWith: Error | null = null;
  public runNowResult: RunNowResult = { runId: RUN_ID };
  public subscriptions = 0;
  public unsubscriptions = 0;

  private listeners = new Set<ISubscription>();

  public reset(): void {
    this.schedules = [];
    this.runs.clear();
    this.events = [];
    this.errors = [];
    this.calls = [];
    this.failWith = null;
    this.runNowResult = { runId: RUN_ID };
    this.subscriptions = 0;
    this.unsubscriptions = 0;
    this.listeners.clear();
  }

  public get activeSubscriptions(): number {
    return this.listeners.size;
  }

  public callsTo(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  public async listSchedules(): Promise<ScheduleInfo[]> {
    this.record('listSchedules');
    return this.schedules;
  }

  public async getSchedule(name: string): Promise<ScheduleDetail> {
    this.record('getSchedule', name);
    const schedule = this.schedules.find((s) => s.name === name);
    if (!schedule) {
      throw new ScheduleNotFound(name);
    }
    return { ...schedule, definition: {}, recentRuns: [], openErrors: [] };
  }

  public async runNow(name: string, options: RunNowOptions): Promise<RunNowResult> {
    this.record('runNow', name, options);
    return this.runNowResult;
  }

  public async listRuns(filter: RunFilter = {}): Promise<Page<RunInfo>> {
    this.record('listRuns', filter);
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    const items = [...this.runs.values()];
    return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
  }

  public async getRun(id: string): Promise<RunDetail> {
    this.record('getRun', id);
    const run = this.runs.get(id);
    if (!run) {
      throw new RunNotFound(id);
    }
    return run;
  }

  public async subscribe(target: SubscribeTarget, listener: RunEventListener, options: SubscribeOptions = {}): Promise<Unsubscribe> {
    this.record('subscribe', target, options);

    const matches = (e: RunEvent) => ('runId' in target ? e.runId === target.runId : e.schedule === target.schedule);
    const position = (e: RunEvent) => ('runId' in target ? e.seq : e.id);

    // core contract: without `after` a run target replays from the start, a schedule target is live only
    const after = options.after ?? ('runId' in target ? 0 : undefined);
    if (after !== undefined) {
      this.events.filter((e) => matches(e) && position(e) > after).forEach(listener);
    }

    const entry = { matches, listener };
    this.listeners.add(entry);
    this.subscriptions++;

    return () => {
      if (this.listeners.delete(entry)) {
        this.unsubscriptions++;
      }
    };
  }

  public async cancel(runId: string, ctx: ActionContext): Promise<RunInfo> {
    this.record('cancel', runId, ctx);
    return { ...(this.runs.get(runId) ?? makeRun({ id: runId })), cancelRequested: true };
  }

  public async retry(runId: string, options: RetryOptions): Promise<RunNowResult> {
    this.record('retry', runId, options);
    return { runId: OTHER_RUN_ID };
  }

  public async retryFailed(name: string, since: Date | string, ctx: ActionContext): Promise<{ runIds: string[] }> {
    this.record('retryFailed', name, since, ctx);
    return { runIds: [OTHER_RUN_ID] };
  }

  public async pause(name: string, options: PauseOptions): Promise<ScheduleInfo> {
    this.record('pause', name, options);
    return makeSchedule({ name, paused: true, pausedReason: 'manual', hardPaused: options.hard ?? false });
  }

  public async resume(name: string, ctx: ActionContext): Promise<ScheduleInfo> {
    this.record('resume', name, ctx);
    return makeSchedule({ name });
  }

  public async listErrors(filter: ErrorFilter = {}): Promise<ErrorGroupInfo[]> {
    this.record('listErrors', filter);
    return this.errors;
  }

  public async setErrorStatus(fingerprint: string, status: ErrorGroupStatus, ctx: ActionContext): Promise<ErrorGroupInfo> {
    this.record('setErrorStatus', fingerprint, status, ctx);
    const group = this.errors.find((e) => e.fingerprint === fingerprint);
    if (!group) {
      throw new ErrorGroupNotFound(fingerprint);
    }
    return { ...group, status };
  }

  public async prune(ctx: ActionContext): Promise<PruneResult> {
    this.record('prune', ctx);
    return { orphanedSchedules: 0, runs: 3, logs: 10, errors: 1 };
  }

  public emit(event: RunEvent): void {
    this.events.push(event);
    this.deliver(event);
  }

  /** Simulates the replay and the live feed both handing over the same event. */
  public deliverTwice(event: RunEvent): void {
    this.emit(event);
    this.deliver(event);
  }

  private deliver(event: RunEvent) {
    for (const { matches, listener } of [...this.listeners]) {
      if (matches(event)) {
        listener(event);
      }
    }
  }

  private record(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });

    if (this.failWith) {
      const err = this.failWith;
      this.failWith = null;
      throw err;
    }
  }
}
