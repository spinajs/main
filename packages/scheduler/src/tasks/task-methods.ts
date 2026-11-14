import { Constructor, DI } from '@spinajs/di';
import { ScheduledTask } from '../ScheduledTask.js';
import { outsideRunContext } from '../run/current.js';

/**
 * The parts of `@spinajs/tasks`' `TaskDeclaration` / `runTask` the scheduler uses. Declared here because
 * `@spinajs/tasks` depends on the scheduler, not the other way round.
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
/** @deprecated The scheduler no longer imports `@spinajs/tasks`; removed in 5.0. */
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
 * Runs the `@Task` method as the body of a run the scheduler already claimed, so `runTask` must not
 * start a run of its own (`lock: false`). rethrow lets retries see failures.
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

const methods = new Map<string, Constructor<ScheduledTask>[]>();
const stacking = new WeakSet<Constructor<ScheduledTask>>();

/**
 * Called by the `@Task` shim, so config entries can name a `@Task` method in `task`. `stacking` is the
 * declaration's `taskStacking`: its inline calls take no schedule lease. Returns an undo.
 */
export function registerTaskMethod(
  taskName: string,
  adapter: Constructor<ScheduledTask>,
  opts: { stacking?: boolean } = {},
): () => void {
  methods.set(taskName, [...(methods.get(taskName) ?? []), adapter]);
  if (opts.stacking) stacking.add(adapter);
  return () => {
    const left = (methods.get(taskName) ?? []).filter((a) => a !== adapter);
    if (left.length) methods.set(taskName, left);
    else methods.delete(taskName);
  };
}

export const findTaskMethods: TaskMethodLookup = (taskName) => [...(methods.get(taskName) ?? [])];

/** Read from the declaration, so a config entry of the same name cannot change it. */
export function isStackingTaskMethod(target: Constructor<ScheduledTask>): boolean {
  return stacking.has(target);
}

export function isTaskMethodAdapter(target: Constructor<ScheduledTask>): boolean {
  for (const adapters of methods.values()) if (adapters.includes(target)) return true;
  return false;
}

/** @deprecated `@Task` registers its methods itself; use {@link findTaskMethods}. Removed in 5.0. */
export function loadTaskMethodLookup(_importTasks?: () => Promise<TaskMethodsModule>): Promise<TaskMethodLookup> {
  return Promise.resolve(findTaskMethods);
}
