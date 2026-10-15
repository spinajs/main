import { mutex_acquire, mutex_release, mutex_renew } from '@spinajs/threading';
import { _check_arg, _non_empty, _trim } from '@spinajs/util';
import { DI } from '@spinajs/di';
import { __task } from './models/__task.js';
import { DateTime } from 'luxon';
import { __task_history } from './models/__task_history.js';
import { Log } from '@spinajs/log-common';
import { TaskSuccess } from './events/TaskSuccess.js';
import { TaskFailed } from './events/TaskFailed.js';

export const TASK_COMMAND = 'task:command';

export interface TaskOptions {
  /**
   * Allow several runs of the same task at once, e.g. a long run that overlaps the next start.
   */
  taskStacking: boolean;

  /**
   * Lifetime of the task mutex in ms, renewed every lockTtl / 3 while the task runs, so a
   * crashed process frees the task after at most lockTtl. 0 = never expires.
   */
  lockTtl: number;
}

export const DEFAULT_TASK_OPTIONS: TaskOptions = {
  taskStacking: false,
  lockTtl: 60000,
};

type Unlock = () => Promise<void>;

// The mutex is re-entrant per tenant and the default tenant is per process,
// so overlapping runs inside one process are excluded here, not by the mutex.
const runningInProcess = new Set<string>();

async function lockTask(name: string, opts: TaskOptions, log: Log): Promise<Unlock | null> {
  if (opts.taskStacking) {
    return async () => {};
  }

  if (runningInProcess.has(name)) {
    log.warn(`Task ${name} is already running in this process`);
    return null;
  }

  runningInProcess.add(name);
  const mutexName = `task-${name}`;

  try {
    const lock = await mutex_acquire({ Name: mutexName, ttl: opts.lockTtl });
    if (!lock.Locked) {
      runningInProcess.delete(name);
      log.warn(`Cannot acquire mutex for task ${name}, already locked !`);
      return null;
    }
  } catch (err) {
    runningInProcess.delete(name);
    throw err;
  }

  const heartbeat =
    opts.lockTtl > 0
      ? setInterval(() => {
          mutex_renew({ Name: mutexName, ttl: opts.lockTtl })
            .then((renewed) => {
              if (!renewed) {
                log.warn(`Task ${name} lost its mutex, another process may run it now`);
              }
            })
            .catch((err) => log.error(err, `Cannot renew mutex for task ${name}`));
        }, Math.max(1, Math.floor(opts.lockTtl / 3)))
      : undefined;

  return async () => {
    clearInterval(heartbeat);
    runningInProcess.delete(name);
    await mutex_release({ Name: mutexName });
  };
}

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
  /** false: skip the task mutex, its heartbeat and the in-process guard (the caller holds a lock of its own). */
  lock: boolean;
  /** true: rethrow the task's error after history is written, instead of resolving with `{ error: true }`. */
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

const NO_LOCK: Unlock = () => Promise.resolve();

/**
 * Runs a task method with the `@Task` bookkeeping: `__tasks` state, a `__task_history` row and
 * TaskSuccess / TaskFailed. The decorator calls it with `{ lock: true, rethrow: false }`.
 */
export async function runTask(
  decl: TaskDeclaration,
  thisArg: unknown,
  args: unknown[],
  opts: RunTaskOptions,
): Promise<unknown> {
  const log = DI.resolve('__log__', ['TASKS']) as Log;
  log.info(`Executing task ${decl.name} ...`);

  let task: __task;
  let unlock: Unlock;
  try {
    task = await __task.getOrCreate(null, {
      Name: decl.name,
      Description: decl.description,
      State: 'stopped',
    });

    const lock = opts.lock ? await lockTask(decl.name, decl.options, log) : NO_LOCK;
    if (!lock) {
      return undefined;
    }
    unlock = lock;

    try {
      task.State = 'running';
      task.LastRunAt = DateTime.now();
      await task.update();
    } catch (err) {
      await unlock();
      throw err;
    }
  } catch (err) {
    log.error(err, `Cannot start task ${decl.name}`);
    throw err;
  }

  let taskResult: unknown = null;
  let failure: { error: unknown } | null = null;
  const start = DateTime.now();
  try {
    try {
      taskResult = await decl.method.apply(thisArg, args);
    } catch (err) {
      failure = { error: err };
      log.error(err, `Cannot execute task ${decl.name}`);
      taskResult = {
        error: true,
        message: errorMessage(err),
      };
    }

    // An emit failure (queue outage) is logged only: it must not turn a run whose side effects
    // already happened into a failure that a caller would retry.
    try {
      if (failure) {
        await TaskFailed.emit({
          TaskName: decl.name,
          Reason: errorMessage(failure.error),
        });
      } else {
        await TaskSuccess.emit({
          TaskName: decl.name,
        });
        log.success(`Task ${decl.name} executed !`);
      }
    } catch (emitErr) {
      log.error(emitErr, `Cannot emit ${failure ? 'TaskFailed' : 'TaskSuccess'} for ${decl.name}`);
    }
  } finally {
    try {
      await unlock();

      await task.update({
        State: 'stopped',
      });

      await __task_history.insert({
        TaskId: task.Id,
        Result: taskResult,
        Duration: DateTime.now().diff(start).milliseconds,
      });
    } catch (err) {
      log.error(err, `Cannot finalize task`);
    }
  }

  if (failure && opts.rethrow) {
    throw failure.error;
  }
  return taskResult;
}

/**
 * Marks a method as a task: records runs in `__tasks` / `__task_history`, emits
 * TaskSuccess / TaskFailed and, unless `taskStacking` is set, lets only one run
 * happen at a time across all processes sharing the database. The declaration is
 * also recorded, so `@spinajs/scheduler` can schedule the method by task name.
 *
 * @param taskName - unique task name
 * @param description - short description
 * @param opts - see {@link TaskOptions}, defaults to {@link DEFAULT_TASK_OPTIONS}
 */
export function Task(taskName: string, description: string, opts?: Partial<TaskOptions>) {
  const _name: string = _check_arg(_trim(), _non_empty())(taskName, 'Task name is empty');
  const _description: string = _check_arg(_trim(), _non_empty())(description, 'Task description is empty');
  const _opts: TaskOptions = { ...DEFAULT_TASK_OPTIONS, ...opts };

  return function (target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor) {
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
    declarations.set(_name, [...(declarations.get(_name) ?? []), decl]);

    descriptor.value = function (...args: any[]) {
      return runTask(decl, this, args, { lock: true, rethrow: false });
    };
  };
}
