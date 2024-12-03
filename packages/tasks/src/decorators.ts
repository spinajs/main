import { QueueService } from '@spinajs/queue';
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
  return function (target: any, _propertyKey: string | symbol, descriptor: PropertyDescriptor) {
    descriptor.value = async function (...args: any[]) {
      const log = DI.resolve('__log__', ['TASKS']) as Log;

      try {
        let task = await __task
          .where({
            Name: taskName,
          })
          .first();

        if (!task) {
          task = new __task({
            Name: taskName,
            Description: description,
            State: 'stopped',
          });

          await task.insert();
        }

        if (task.State === 'running' && opts.taskStacking === false) {
          return Promise.reject(`Cannot stack task ${taskName} - task is already running`);
        }

        task.State = 'running';
        task.LastRunAt = DateTime.now();
        await task.update();

        let taskResult = null;
        const start = DateTime.now();
        try {
          taskResult = await target.apply(this, args);
          await TaskSuccess.emit({
            TaskName: taskName,
          });
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
          const end = DateTime.now();

          try {
            task.State = 'stopped';
            await task.update();
          } catch (err) {
            log.error(err, `Cannot update task ${taskName} state`);
          }

          try {
            __task_history.insert({
              TaskId: task.Id,
              Result: JSON.stringify(taskResult),
              Duration: end.diff(start).milliseconds,
            });
          } catch (err) {
            log.error(err, `Cannot update ${taskName} history`);
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
