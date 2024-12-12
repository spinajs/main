import { mutex_acquire, mutext_release } from '@spinajs/threading';
import { _check_arg, _non_empty, _trim } from '@spinajs/util';
import { DI } from '@spinajs/di';
import { __task } from './models/__task.js';
import { DateTime } from 'luxon';
import { __task_history } from './models/__task_history.js';
import { Log } from '@spinajs/log-common';
import { TaskSuccess } from './events/TaskSuccess.js';
import { TaskFailed } from './events/TaskFailed.js';

export const TASK_COMMAND = 'task:command';

interface TaskOptions {
  // allow for multiple task running in same time22
  // eg. long running task that overlaps beginning of another same task
  // by default is set to false.
  taskStacking: boolean;
}

/**
 * Cli command, wrapper for lib commander. For more docs on command options & args check
 * https://github.com/tj/commander.js
 *
 * It allows to use all features that spinajs provides eg. DI, logging, intl support etc.
 * inside command functions without hassle.
 *
 * @param nameAndArgs - name of command with optional args defined
 * @param description  - short description
 * @param opts - additional options, see https://github.com/tj/commander.js
 */
export function Task(taskName: string, description: string, opts?: TaskOptions) {
  const _name = _check_arg(_trim(), _non_empty())(taskName, 'Task name is empty');
  const _description = _check_arg(_trim(), _non_empty())(description, 'Task description is empty');

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

        if (!opts.taskStacking) {
          const lock = await mutex_acquire({
            Name: `task-${_name}`,
          });

          if (!lock.Locked) {
            log.warn(`Cannot acquire mutex for task ${_name}, already locked !`);
            return;
          }
        }

        task.State = 'running';
        task.LastRunAt = DateTime.now();
        await task.update();

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
            await mutext_release({
              Name: `task-${name}`,
            });

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
