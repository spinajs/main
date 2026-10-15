import { Autoinject, Injectable, Singleton } from '@spinajs/di';
import { MethodNotImplemented } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log-common';
import type { IWhereBuilder } from '@spinajs/orm';
import {
  ActionContext,
  ErrorFilter,
  ErrorGroupInfo,
  ErrorGroupStatus,
  Page,
  PauseOptions,
  PruneResult,
  RetryOptions,
  RunDetail,
  RunEventListener,
  RunFilter,
  RunInfo,
  RunNotFound,
  RunNowOptions,
  RunNowResult,
  ScheduleDetail,
  ScheduleInfo,
  ScheduleNotFound,
  SchedulerService,
  SubscribeOptions,
  SubscribeTarget,
  TriggeredBy,
  Unsubscribe,
} from '../contract.js';
import { ErrorGroupModel } from '../models/ErrorGroupModel.js';
import { RunAttemptModel } from '../models/RunAttemptModel.js';
import { RunLogModel } from '../models/RunLogModel.js';
import { RunModel } from '../models/RunModel.js';
import { RunStepModel } from '../models/RunStepModel.js';
import { ScheduleModel } from '../models/ScheduleModel.js';
import { ScheduleRegistry } from '../registry/ScheduleRegistry.js';
import { toRunEvent } from '../run/events.js';
import { RunEventHub } from '../run/RunEventHub.js';
import { DefinitionSync } from '../store/DefinitionSync.js';
import { DbClock } from '../time/clock.js';
import { toArray, toAttemptInfo, toErrorGroupInfo, toMs, toRunInfo, toScheduleInfo, toStepInfo } from './mappers.js';

const DEFAULT_PAGE = 50;
const MAX_PAGE = 500;
const RECENT_RUNS = 20;
const DETAIL_LOGS = 200;

const intOr = (v: number | undefined, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback;

/**
 * The single façade over schedules and runs; the CLI and `@spinajs/scheduler-http` call only this.
 * Errors leave it only as the contract's error classes, which `httpStatusForError` / `exitCodeForError` map.
 */
@Singleton()
@Injectable(SchedulerService)
export class DefaultSchedulerService extends SchedulerService {
  @Logger('SCHEDULER')
  protected Log: Log;

  @Autoinject(ScheduleRegistry)
  protected Registry: ScheduleRegistry;

  @Autoinject(DefinitionSync)
  protected Sync: DefinitionSync;

  @Autoinject(DbClock)
  protected Clock: DbClock;

  @Autoinject(RunEventHub)
  protected Hub: RunEventHub;

  /** A process that never starts the loop (CLI, API-only replica) still sees every schedule. */
  public async resolve(): Promise<void> {
    await this.Sync.sync(this.Registry.all(), await this.Clock.sync());
    await super.resolve();
  }

  public async listSchedules(): Promise<ScheduleInfo[]> {
    const now = await this.now();
    const rows = await ScheduleModel.query().orderBy('Name');
    const lastIds = rows.map((r) => r.LastRunId).filter((id): id is string => !!id);
    const last = lastIds.length ? await RunModel.query().whereIn('Id', lastIds) : [];
    const running = await RunModel.where('Status', 'running');
    return rows.map((row) =>
      toScheduleInfo(
        row,
        this.Registry.find(row.Name),
        running.find((r) => r.Schedule === row.Name) ?? last.find((r) => r.Id === row.LastRunId) ?? null,
        now,
      ),
    );
  }

  public async getSchedule(name: string): Promise<ScheduleDetail> {
    const now = await this.now();
    const row = await this.loadScheduleRow(name);
    const recent = await this.listRuns({ schedule: name, limit: RECENT_RUNS });
    const openErrors = await this.listErrors({ schedule: name, status: 'open' });
    return {
      ...toScheduleInfo(row, this.Registry.find(name), await this.lastRunOf(row), now),
      definition: row.Definition ?? {},
      recentRuns: recent.items,
      openErrors,
    };
  }

  public async listRuns(filter: RunFilter = {}): Promise<Page<RunInfo>> {
    const now = await this.now();
    const limit = Math.min(Math.max(intOr(filter.limit, DEFAULT_PAGE), 1), MAX_PAGE);
    const offset = Math.max(intOr(filter.offset, 0), 0);
    const from = filter.from !== undefined ? toMs(filter.from) : undefined;
    const to = filter.to !== undefined ? toMs(filter.to) : undefined;
    const apply = <B extends IWhereBuilder<unknown>>(q: B): B => {
      if (filter.schedule) q.where('Schedule', filter.schedule);
      if (filter.status) q.whereIn('Status', toArray(filter.status));
      if (filter.trigger) q.whereIn('Trigger', toArray(filter.trigger));
      if (from !== undefined) q.where('CreatedAt', '>=', from);
      if (to !== undefined) q.where('CreatedAt', '<=', to);
      return q;
    };
    // Postgres returns COUNT(*) as an int8 string
    const total = Number(await RunModel.count((b) => void apply(b as IWhereBuilder<unknown>)));
    const rows = await apply(RunModel.query()).orderByDescending('CreatedAt').skip(offset).take(limit);
    return { items: rows.map((r) => this.info(r, now)), total, limit, offset };
  }

  public async getRun(id: string): Promise<RunDetail> {
    const now = await this.now();
    const run = await this.loadRun(id);
    const attempts = await RunAttemptModel.where('RunId', id).orderBy('Attempt');
    const steps = await RunStepModel.where('RunId', id).orderBy('Id');
    const logs = await RunLogModel.where('RunId', id)
      .whereIn('Kind', ['log', 'message', 'error'])
      .orderByDescending('Seq')
      .take(DETAIL_LOGS);
    return {
      ...this.info(run, now),
      attempts: attempts.map(toAttemptInfo),
      steps: steps.map(toStepInfo),
      logs: logs.reverse().map(toRunEvent),
      checkpoint: run.Checkpoint ?? null,
    };
  }

  /** Synthetic `progress` events (R16) are passed through as the hub delivers them. */
  public async subscribe(
    target: SubscribeTarget,
    listener: RunEventListener,
    options?: SubscribeOptions,
  ): Promise<Unsubscribe> {
    if ('runId' in target) await this.loadRun(target.runId);
    else if (!this.Registry.find(target.schedule)) await this.loadScheduleRow(target.schedule);
    return this.Hub.subscribe(target, listener, options);
  }

  public async listErrors(filter: ErrorFilter = {}): Promise<ErrorGroupInfo[]> {
    const q = ErrorGroupModel.query();
    if (filter.schedule) q.where('Schedule', filter.schedule);
    if (filter.status) q.whereIn('Status', toArray(filter.status));
    return (await q.orderByDescending('LastSeen')).map(toErrorGroupInfo);
  }

  // Replaced in Tasks 35-37.
  public runNow(_name: string, _options: RunNowOptions): Promise<RunNowResult> {
    throw new MethodNotImplemented('runNow');
  }
  public cancel(_runId: string, _ctx: ActionContext): Promise<RunInfo> {
    throw new MethodNotImplemented('cancel');
  }
  public retry(_runId: string, _options: RetryOptions): Promise<RunNowResult> {
    throw new MethodNotImplemented('retry');
  }
  public retryFailed(_name: string, _since: Date | string, _ctx: ActionContext): Promise<{ runIds: string[] }> {
    throw new MethodNotImplemented('retryFailed');
  }
  public pause(_name: string, _options: PauseOptions): Promise<ScheduleInfo> {
    throw new MethodNotImplemented('pause');
  }
  public resume(_name: string, _ctx: ActionContext): Promise<ScheduleInfo> {
    throw new MethodNotImplemented('resume');
  }
  public setErrorStatus(_fingerprint: string, _status: ErrorGroupStatus, _ctx: ActionContext): Promise<ErrorGroupInfo> {
    throw new MethodNotImplemented('setErrorStatus');
  }
  public prune(_ctx: ActionContext): Promise<PruneResult> {
    throw new MethodNotImplemented('prune');
  }

  protected now(): Promise<number> {
    return this.Clock.sync();
  }

  protected async loadRun(id: string): Promise<RunModel> {
    const run = await RunModel.where('Id', id).first();
    if (!run) throw new RunNotFound(id);
    return run;
  }

  protected async loadScheduleRow(name: string): Promise<ScheduleModel> {
    const row = await ScheduleModel.where('Name', name).first();
    if (!row) throw new ScheduleNotFound(name);
    return row;
  }

  /** A run in progress wins over the last finished one. */
  protected async lastRunOf(row: ScheduleModel): Promise<RunModel | null> {
    const running = await RunModel.where('Schedule', row.Name)
      .where('Status', 'running')
      .orderByDescending('StartedAt')
      .first();
    if (running) return running;
    return row.LastRunId ? (await RunModel.where('Id', row.LastRunId).first()) ?? null : null;
  }

  protected async scheduleInfo(name: string, now: number): Promise<ScheduleInfo> {
    const row = await this.loadScheduleRow(name);
    return toScheduleInfo(row, this.Registry.find(name), await this.lastRunOf(row), now);
  }

  protected info(run: RunModel, now: number): RunInfo {
    return toRunInfo(run, now, this.Registry.config.leaseTtl);
  }

  protected audit(action: string, by: TriggeredBy, details: Record<string, unknown>): void {
    this.Log.info(
      { audit: true, action, triggeredBy: by, ...details },
      `scheduler audit: ${action} by ${by.kind}:${by.id}`,
    );
  }
}
