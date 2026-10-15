import { mutex_acquire, mutex_release } from '@spinajs/threading';
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
}

export const DEFAULT_TASK_OPTIONS: TaskOptions = {
  taskStacking: false,
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
    const lock = await mutex_acquire({ Name: mutexName });
    if (!lock.Locked) {
      runningInProcess.delete(name);
      log.warn(`Cannot acquire mutex for task ${name}, already locked !`);
      return null;
    }
  } catch (err) {
    runningInProcess.delete(name);
    throw err;
  }

  return async () => {
    runningInProcess.delete(name);
    await mutex_release({ Name: mutexName });
  };
}

/**
 * Marks a method as a task: records runs in `__tasks` / `__task_history`, emits
 * TaskSuccess / TaskFailed and, unless `taskStacking` is set, lets only one run
 * happen at a time across all processes sharing the database.
 *
 * @param taskName - unique task name
 * @param description - short description
 * @param opts - see {@link TaskOptions}, defaults to {@link DEFAULT_TASK_OPTIONS}
 */
export function Task(taskName: string, description: string, opts?: Partial<TaskOptions>) {
  const _name = _check_arg(_trim(), _non_empty())(taskName, 'Task name is empty');
  const _description = _check_arg(_trim(), _non_empty())(description, 'Task description is empty');
  const _opts: TaskOptions = { ...DEFAULT_TASK_OPTIONS, ...opts };

  return function (_target: any, _propertyKey: string | symbol, descriptor: PropertyDescriptor) {
    const oldFunction: Function = descriptor.value;
    descriptor.value = async function (...args: any[]) {
      const log = DI.resolve('__log__', ['TASKS']) as Log;

      log.info(`Executing task ${_name} ...`);

      try {
        const task = await __task.getOrCreate(null, {
          Name: _name,
          Description: _description,
          State: 'stopped',
        });

        const unlock = await lockTask(_name, _opts, log);
        if (!unlock) {
          return;
        }

        try {
          task.State = 'running';
          task.LastRunAt = DateTime.now();
          await task.update();
        } catch (err) {
          await unlock();
          throw err;
        }

        let taskResult = null;
        const start = DateTime.now();
        try {
          taskResult = await oldFunction.apply(this, args);
          await TaskSuccess.emit({
            TaskName: taskName,
          });

          log.success(`Task ${taskName} executed !`);
        } catch (err) {
          log.error(err, `Cannot execute task ${taskName}`);
          taskResult = {
            error: true,
            message: err.Message,
          };

          await TaskFailed.emit({
            TaskName: taskName,
            Reason: err.Message,
          });
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

          return taskResult;
        }
      } catch (err) {
        log.error(err, `Cannot start task ${taskName}`);
        throw err;
      }
    };
  };
}
