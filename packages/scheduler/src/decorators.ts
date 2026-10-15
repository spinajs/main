import type { Constructor } from '@spinajs/di';
import type { ScheduleOptions, SchedulerConfig } from './interfaces.js';
import type { ScheduledTask } from './ScheduledTask.js';

export interface ScheduleDeclaration {
  name: string;
  options: ScheduleOptions;
  target: Constructor<ScheduledTask>;
  source?: 'decorator' | 'builtin';
}

const DECLARATIONS: ScheduleDeclaration[] = [];
const BUILTINS: Array<(cfg: SchedulerConfig) => ScheduleDeclaration | null> = [];

export function defineSchedule(target: Constructor<ScheduledTask>, name: string, options: ScheduleOptions = {}): void {
  DECLARATIONS.push({ name, options, target, source: 'decorator' });
}

export function undefineSchedule(name: string): void {
  for (let i = DECLARATIONS.length - 1; i >= 0; i--) {
    if (DECLARATIONS[i].name === name) DECLARATIONS.splice(i, 1);
  }
}

export function getScheduleDeclarations(): ScheduleDeclaration[] {
  return [...DECLARATIONS];
}

export function Schedule(name: string, options?: ScheduleOptions) {
  return (target: Constructor<ScheduledTask>) => {
    defineSchedule(target, name, options);
  };
}

/** Returns a function that removes the factory again. */
export function registerBuiltinSchedule(factory: (cfg: SchedulerConfig) => ScheduleDeclaration | null): () => void {
  BUILTINS.push(factory);
  return () => {
    const i = BUILTINS.indexOf(factory);
    if (i >= 0) BUILTINS.splice(i, 1);
  };
}

export function getBuiltinDeclarations(cfg: SchedulerConfig): ScheduleDeclaration[] {
  return BUILTINS.map((f) => f(cfg)).filter((d): d is ScheduleDeclaration => d !== null);
}
