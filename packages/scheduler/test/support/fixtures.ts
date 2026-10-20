import { DI, Constructor } from '@spinajs/di';
import { v4 as uuidv4 } from 'uuid';
import {
  buildDefinitions,
  DefinitionSync,
  FakeClock,
  RunEvent,
  RunLogModel,
  RunModel,
  ScheduledTask,
  ScheduleDefinition,
  ScheduleOptions,
  toRunEvent,
} from '../../src/index.js';
import { waitFor } from './env.js';

export function makeDef(name: string, options: ScheduleOptions, task: Constructor<ScheduledTask>): ScheduleDefinition {
  return buildDefinitions({
    declarations: [{ name, options, target: task }],
    config: [],
    tickMs: 1000,
    validateParamsSchema: () => null,
  })[0];
}

export async function seedSchedules(defs: ScheduleDefinition[], now: number): Promise<void> {
  await DI.resolve(DefinitionSync).sync(defs, now);
}

export function queuedRun(schedule: string, now: number, extra: Partial<RunModel> = {}): Promise<RunModel> {
  return RunModel.create({
    Id: uuidv4(),
    Schedule: schedule,
    Trigger: 'manual',
    Status: 'queued',
    Attempt: 1,
    MaxAttempts: 1,
    CreatedAt: now,
    Progress: 0,
    CancelRequested: false,
    Forced: false,
    ...extra,
  });
}

export const getRun = (id: string): Promise<RunModel> => RunModel.where('Id', id).first();

export async function journal(runId: string): Promise<RunEvent[]> {
  return (await RunLogModel.where('RunId', runId).orderBy('Seq')).map(toRunEvent);
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Advances fake time step by step until `work` settles. Timers are often registered
 * after real database I/O, so a single large advance can run before they exist.
 */
export async function driveUntil(clock: FakeClock, work: Promise<unknown>, stepMs = 1000): Promise<void> {
  let finished = false;
  const settle = () => (finished = true);
  void work.then(settle, settle);
  await waitFor(async () => {
    if (!finished) await clock.advance(stepMs);
    return finished;
  }, 10_000);
}

/** Rejects with the signal's reason once it aborts, like well-behaved I/O would. */
export function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
