import { NewInstance } from '@spinajs/di';
import { Log, type ILogEntry } from '@spinajs/log-common';

const noop = (): void => undefined;
const text = (m: unknown): string => (typeof m === 'string' ? m : m instanceof Error ? m.message : JSON.stringify(m));

/**
 * Registered `.as(Log)` before a boot: `@Logger('WORKFLOW')` resolves `Log` by name, so the engine's warnings land in
 * `warnings`. DI keeps the registration for the rest of the process (every logger resolved later is a SpyLog), hence
 * the static capture list and `reset()` at the start of each test that reads it. `@NewInstance`, as `FrameworkLogger`:
 * a cached singleton would answer every logger name with the first one resolved.
 */
@NewInstance()
export class SpyLog extends Log {
  public static warnings: string[] = [];
  /** Only this logger name is captured; the ORM's and the queue's loggers stay silent. */
  public static capture = 'WORKFLOW';

  public static reset(): void {
    SpyLog.warnings = [];
  }

  constructor(public Name: string) {
    super();
  }

  public child(): Log {
    return this;
  }

  public warn(message: unknown): void {
    if (this.Name === SpyLog.capture) SpyLog.warnings.push(text(message));
  }

  public trace(): void {
    noop();
  }
  public debug(): void {
    noop();
  }
  public info(): void {
    noop();
  }
  public error(): void {
    noop();
  }
  public fatal(): void {
    noop();
  }
  public security(): void {
    noop();
  }
  public success(): void {
    noop();
  }
  public write(_entry: ILogEntry): Promise<PromiseSettledResult<void>[]> {
    return Promise.resolve([]);
  }
}
