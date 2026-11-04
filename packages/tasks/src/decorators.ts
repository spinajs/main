import { _check_arg, _non_empty, _trim } from '@spinajs/util';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import {
  defineSchedule,
  isCrashError,
  registerTaskMethod,
  RunAbortedError,
  ScheduleOverlap,
  SchedulerService,
  taskMethodSchedule,
} from '@spinajs/scheduler';
import { __task } from './models/__task.js';
import { DateTime } from 'luxon';
import { __task_history } from './models/__task_history.js';
import { Log, LOG } from '@spinajs/log-common';
import { TaskSuccess } from './events/TaskSuccess.js';
import { TaskFailed } from './events/TaskFailed.js';

export const TASK_COMMAND = 'task:command';

export interface TaskOptions {
  /**
   * Allow several runs of the same task at once. Maps to the schedule's `overlap`: `true` is
   * `'queue'` (calls never wait for each other), `false` is `'skip'` (a call while another run holds
   * the schedule lease is skipped).
   */
  taskStacking: boolean;

  /** @deprecated Ignored: runs are guarded by the scheduler lease (`scheduler.leaseTtl`). */
  lockTtl: number;
}

export const DEFAULT_TASK_OPTIONS: TaskOptions = {
  taskStacking: false,
  lockTtl: 60000,
};

export interface TaskDeclaration {
  name: string;
  description: string;
  options: TaskOptions;
  /** The class that declares the method (the constructor itself for a static method). */
  target: Function;
  isStatic: boolean;
  propertyKey: string | symbol;
  /** The undecorated method. */
  method: (...args: any[]) => unknown;
}

export interface RunTaskOptions {
  /**
   * true: run as a `manual` scheduler run of the task's schedule, under its lease.
   * false: the caller already is inside a run (the scheduler executing the task's schedule).
   */
  lock: boolean;
  /** true: rethrow the method's error instead of resolving with `{ error: true }`. A skipped call resolves `undefined` either way. */
  rethrow: boolean;
}

const declarations = new Map<string, TaskDeclaration[]>();

export function getTaskDeclarations(name?: string): TaskDeclaration[] {
  if (name !== undefined) {
    return [...(declarations.get(name) ?? [])];
  }
  return [...declarations.values()].flat();
}

function errorMessage(err: unknown): string {
  return (err as { message?: string } | null | undefined)?.message ?? String(err);
}

function legacyHistory(): boolean {
  return DI.get(Configuration)?.get<boolean>('tasks.legacyHistory', true) ?? true;
}

async function legacyTaskRow(decl: TaskDeclaration): Promise<__task> {
  return __task
    .getOrCreate(null, {
      Name: decl.name,
      Description: decl.description,
      State: 'stopped',
    })
    .catch(async (err) => {
      // another process may have inserted the row between getOrCreate's select and insert
      const existing = await __task
        .where({ Name: decl.name })
        .first()
        .catch((): undefined => undefined);
      if (!existing) {
        throw err;
      }
      return existing;
    });
}

async function emitOutcome(decl: TaskDeclaration, failure: { error: unknown } | null, log: Log): Promise<void> {
  // An emit failure (queue outage) is logged only: it must not turn a run whose side effects
  // already happened into a failure that a caller would retry.
  try {
    if (failure) {
      await TaskFailed.emit({ TaskName: decl.name, Reason: errorMessage(failure.error) });
    } else {
      await TaskSuccess.emit({ TaskName: decl.name });
      log.success({ taskName: decl.name }, 'Task ${taskName} executed !');
    }
  } catch (emitErr) {
    log.error(
      { error: emitErr, event: failure ? 'TaskFailed' : 'TaskSuccess', taskName: decl.name },
      'Cannot emit ${event} for ${taskName}',
    );
  }
}

interface TaskCall {
  /** How the method itself ended, so only its own error becomes `{ error: true }`. */
  settled?: { ok: true; value: unknown } | { ok: false; error: unknown };
}

/** The method with the 3.x bookkeeping around it; throws the method's error after the bookkeeping. */
async function executeTask(
  decl: TaskDeclaration,
  thisArg: unknown,
  args: unknown[],
  log: Log,
  call: TaskCall,
): Promise<unknown> {
  const task = legacyHistory() ? await legacyTaskRow(decl) : null;
  if (task) {
    task.State = 'running';
    task.LastRunAt = DateTime.now();
    await task.update();
  }

  let taskResult: unknown;
  let failure: { error: unknown } | null = null;
  const start = DateTime.now();
  try {
    taskResult = await decl.method.apply(thisArg, args);
    call.settled = { ok: true, value: taskResult };
  } catch (err) {
    // a dead process emits and records nothing
    if (isCrashError(err)) throw err;
    call.settled = { ok: false, error: err };
    failure = { error: err };
    log.error({ error: err, taskName: decl.name }, 'Cannot execute task ${taskName}');
    taskResult = { error: true, message: errorMessage(err) };
  }

  await emitOutcome(decl, failure, log);

  if (task) {
    try {
      await task.update({ State: 'stopped' });
      await __task_history.insert({
        TaskId: task.Id,
        Result: taskResult,
        Duration: DateTime.now().diff(start).milliseconds,
      });
    } catch (err) {
      log.error({ error: err, taskName: decl.name }, 'Cannot finalize task ${taskName}');
    }
  }

  if (failure) throw failure.error;
  return taskResult;
}

/**
 * Runs a task method with the `@Task` bookkeeping: a `__scheduler_run` row (when `lock` is set),
 * `__tasks` / `__task_history` while `tasks.legacyHistory` is on, and TaskSuccess / TaskFailed.
 * The decorator calls it with `{ lock: true, rethrow: false }`.
 */
export async function runTask(
  decl: TaskDeclaration,
  thisArg: unknown,
  args: unknown[],
  opts: RunTaskOptions,
): Promise<unknown> {
  const log = DI.resolve(LOG, ['TASKS']);
  log.info({ taskName: decl.name }, 'Executing task ${taskName} ...');

  const call: TaskCall = {};
  try {
    if (!opts.lock) {
      return await executeTask(decl, thisArg, args, log, call);
    }
    const scheduler = await DI.resolve(SchedulerService);
    return await scheduler.runInline(decl.name, () => executeTask(decl, thisArg, args, log, call), {
      triggeredBy: `task:${decl.name}`,
    });
  } catch (err) {
    return endOfFailedCall(decl, call, err, opts, log);
  }
}

function endOfFailedCall(decl: TaskDeclaration, call: TaskCall, err: unknown, opts: RunTaskOptions, log: Log): unknown {
  if (err instanceof ScheduleOverlap) {
    log.warn({ taskName: decl.name }, 'Task ${taskName} is already running, skipped');
    return undefined;
  }
  if (isCrashError(err)) throw err;
  const settled = call.settled;
  // the method ran, but the run could not be recorded as its end (lease lost): 3.x only warned on a lost mutex
  if (settled && err instanceof RunAbortedError && err.reason === 'lease-lost') {
    log.warn({ taskName: decl.name }, 'Task ${taskName} lost its run lease, its end is not recorded');
    return settled.ok ? settled.value : methodFailure(settled.error, opts);
  }
  if (settled && !settled.ok && err === settled.error) return methodFailure(err, opts);
  if (err instanceof RunAbortedError) {
    log.error({ error: err, taskName: decl.name, reason: err.reason }, 'Task ${taskName} was aborted: ${reason}');
  } else {
    log.error({ error: err, taskName: decl.name }, 'Cannot start task ${taskName}');
  }
  throw err;
}

function methodFailure(err: unknown, opts: RunTaskOptions): unknown {
  if (opts.rethrow) throw err;
  return { error: true, message: errorMessage(err) };
}

/**
 * Marks a method as a task. The task is a `manual` schedule of `@spinajs/scheduler` named after the
 * task: calling the method runs it inline as a scheduler run and resolves with its value, with
 * `{ error: true, message }` when it throws, or with `undefined` when another run holds the lease.
 * A failure to start the run, and a run cancelled or timed out before the method settled, reject. Config schedules can name the task in `task`.
 *
 * @deprecated Use `@Schedule` classes and `SchedulerService.runInline`. `@spinajs/tasks` is removed in 5.0.
 * @param taskName - unique task name
 * @param description - short description
 * @param opts - see {@link TaskOptions}, defaults to {@link DEFAULT_TASK_OPTIONS}
 */
export function Task(taskName: string, description: string, opts?: Partial<TaskOptions>) {
  const _name: string = _check_arg(_trim(), _non_empty())(taskName, 'Task name is empty');
  const _description: string = _check_arg(_trim(), _non_empty())(description, 'Task description is empty');
  const _opts: TaskOptions = { ...DEFAULT_TASK_OPTIONS, ...opts };

  return function (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) {
    const isStatic = typeof target === 'function';
    const decl: TaskDeclaration = {
      name: _name,
      description: _description,
      options: _opts,
      target: isStatic ? target : target.constructor,
      isStatic,
      propertyKey,
      method: descriptor.value,
    };
    const first = !declarations.has(_name);
    declarations.set(_name, [...(declarations.get(_name) ?? []), decl]);

    const adapter = taskMethodSchedule(decl, runTask);
    registerTaskMethod(_name, adapter, { stacking: _opts.taskStacking });
    // a second @Task with the same name runs under the first one's schedule
    if (first) {
      defineSchedule(adapter, _name, { manual: true, overlap: _opts.taskStacking ? 'queue' : 'skip' });
    }

    descriptor.value = function (...args: any[]) {
      return runTask(decl, this, args, { lock: true, rethrow: false });
    };
  };
}
