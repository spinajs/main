import { Constructor, DI } from '@spinajs/di';
import { ScheduledTask } from '../ScheduledTask.js';
import { outsideRunContext } from '../run/current.js';

/**
 * The parts of `@spinajs/tasks`' `TaskDeclaration` / `runTask` the scheduler uses. Declared here so the
 * scheduler's typings do not need `@spinajs/tasks`, which is an optional peer.
 *
 * @internal
 */
export interface TaskMethodDeclaration {
  name: string;
  /** The declaring class (the constructor itself for a static method). */
  target: object;
  isStatic: boolean;
}
/** @internal */
export type RunTaskFn<D extends TaskMethodDeclaration = TaskMethodDeclaration> = (
  decl: D,
  thisArg: unknown,
  args: unknown[],
  opts: { lock: boolean; rethrow: boolean },
) => Promise<unknown>;
/** @internal */
export interface TaskMethodsModule {
  getTaskDeclarations(name?: string): TaskMethodDeclaration[];
  runTask(
    decl: TaskMethodDeclaration,
    thisArg: unknown,
    args: unknown[],
    opts: { lock: boolean; rethrow: boolean },
  ): Promise<unknown>;
}

export type TaskMethodLookup = (taskName: string) => Constructor<ScheduledTask>[];

const adapters = new WeakMap<TaskMethodDeclaration, Constructor<ScheduledTask>>();

/**
 * Runs the undecorated `@Task` method without the task mutex: the schedule lease already gives
 * one runner, and a second lock could skip a claimed run. rethrow lets retries see failures.
 */
export function taskMethodSchedule<D extends TaskMethodDeclaration>(
  decl: D,
  runTask: RunTaskFn<D>,
): Constructor<ScheduledTask> {
  let adapter = adapters.get(decl);
  if (!adapter) {
    adapter = class extends ScheduledTask {
      public async execute(): Promise<unknown> {
        const self: unknown = decl.isStatic
          ? decl.target
          : await Promise.resolve(outsideRunContext(() => DI.resolve(decl.target as Constructor<unknown>)));
        return runTask(decl, self, [], { lock: false, rethrow: true });
      }
    };
    Object.defineProperty(adapter, 'name', { value: `Task:${decl.name}` });
    adapters.set(decl, adapter);
  }
  return adapter;
}

// The quoted name is the missing module itself; a dependency missing inside @spinajs/tasks names
// another module and only mentions @spinajs/tasks in its unquoted path, so it is not swallowed.
function isNotInstalled(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  return (
    (e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'MODULE_NOT_FOUND') &&
    typeof e.message === 'string' &&
    e.message.includes("'@spinajs/tasks'")
  );
}

/**
 * `@spinajs/tasks` is optional: without it no config entry can name a `@Task` method.
 *
 * @param importTasks - `@internal` test seam; defaults to importing `@spinajs/tasks`
 */
export async function loadTaskMethodLookup(
  importTasks: () => Promise<TaskMethodsModule> = () => import('@spinajs/tasks'),
): Promise<TaskMethodLookup> {
  let tasks: TaskMethodsModule;
  try {
    tasks = await importTasks();
  } catch (err) {
    if (isNotInstalled(err)) return () => [];
    throw err;
  }
  return (name) =>
    tasks
      .getTaskDeclarations(name)
      .map((d) => taskMethodSchedule(d, (decl, self, args, opts) => tasks.runTask(decl, self, args, opts)));
}
