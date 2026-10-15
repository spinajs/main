import type { Log } from '@spinajs/log-common';
import type { RunTrigger, TriggeredBy } from '../contract.js';
import type { ScheduleDefinition, SchedulerConfig } from '../interfaces.js';
import type { RunModel } from '../models/RunModel.js';
import type { RunProgressPatch } from '../store/LeaseStore.js';
import type { DbClock } from '../time/clock.js';
import type { RunEventWriter } from './RunEventWriter.js';
import type { ExecutionOutcome } from './outcome.js';

export interface RunContextInit {
  run: RunModel;
  def: ScheduleDefinition;
  signal: AbortSignal;
  events: RunEventWriter;
  clock: DbClock;
  log: Log;
  config: SchedulerConfig;
}

/** What a running task sees. Steps, progress, messages and checkpoints arrive in Task 22. */
export class RunContext {
  public readonly runId: string;
  public readonly schedule: string;
  public readonly trigger: RunTrigger;
  public readonly attempt: number;
  public readonly scheduledAt: Date | null;
  public readonly firedAt: Date;
  public readonly params: Record<string, unknown>;
  public readonly triggeredBy: TriggeredBy | null;
  public readonly signal: AbortSignal;

  public currentStepName: string | null = null;

  protected resultValue: unknown = undefined;
  protected hasResult = false;

  constructor(protected readonly init: RunContextInit) {
    const r = init.run;
    this.runId = r.Id;
    this.schedule = r.Schedule;
    this.trigger = r.Trigger;
    this.attempt = r.Attempt;
    this.scheduledAt = r.ScheduledAt ? new Date(r.ScheduledAt) : null;
    this.firedAt = new Date(r.StartedAt ?? init.clock.now());
    this.params = r.Params ?? {};
    this.triggeredBy = r.TriggeredBy ?? null;
    this.signal = init.signal;
  }

  public result(data: unknown): void {
    this.resultValue = data;
    this.hasResult = true;
  }

  public get explicitResult(): { set: boolean; value: unknown } {
    return { set: this.hasResult, value: this.resultValue };
  }

  public get dirty(): boolean {
    return false;
  }

  public snapshot(): RunProgressPatch {
    return {};
  }

  public markFlushed(): void {
    // progress state arrives in Task 22
  }

  public close(_outcome: ExecutionOutcome): Promise<void> {
    // open steps are finalized in Task 22
    return Promise.resolve();
  }
}
