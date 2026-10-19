import { DI, NewInstance } from '@spinajs/di';
import { Log, renderTemplate } from '@spinajs/log-common';

type Level = 'trace' | 'debug' | 'info' | 'success' | 'warn' | 'error' | 'fatal' | 'security';

export interface TestLogLine {
  readonly level: Level;
  readonly logger: string;
  /** The message as a Log would render it: a fields-form template filled, an error-form call's message. */
  readonly message: string;
  readonly args: readonly unknown[];
}

const isFields = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !(v instanceof Error) && !Array.isArray(v);

/** Stands in for the app's Log in tests without @spinajs/log: every line is kept in memory, none is printed. */
@NewInstance()
export class TestLog {
  static readonly lines: TestLogLine[] = [];
  private static readonly warned = new Set<string>();

  /** Forgets the lines and the warnOnce keys. */
  static clear(): void {
    TestLog.lines.length = 0;
    TestLog.warned.clear();
  }

  static messages(level?: Level): string[] {
    return TestLog.lines.filter((l) => level === undefined || l.level === level).map((l) => l.message);
  }

  constructor(readonly Name: string = '') {}

  trace(...args: unknown[]): void {
    this.write('trace', args);
  }
  debug(...args: unknown[]): void {
    this.write('debug', args);
  }
  info(...args: unknown[]): void {
    this.write('info', args);
  }
  success(...args: unknown[]): void {
    this.write('success', args);
  }
  warn(...args: unknown[]): void {
    this.write('warn', args);
  }
  error(...args: unknown[]): void {
    this.write('error', args);
  }
  fatal(...args: unknown[]): void {
    this.write('fatal', args);
  }
  security(...args: unknown[]): void {
    this.write('security', args);
  }

  /** Log.warnOnce, but its keys are forgotten by clear(). */
  warnOnce(key: string, ...args: unknown[]): boolean {
    const id = `${this.Name}\u0000${key}`;
    if (TestLog.warned.has(id)) return false;
    this.write('warn', args);
    TestLog.warned.add(id);
    return true;
  }

  private write(level: Level, args: unknown[]): void {
    const [first, second] = args;
    const message = isFields(first) ? renderTemplate(String(second ?? ''), first) : first instanceof Error ? String(second ?? first.message) : String(first);
    TestLog.lines.push({ level, logger: this.Name, message, args });
  }
}

/** Registers {@link TestLog} as the Log unless one is registered; the returned function undoes exactly that. */
export function installTestLog(): () => void {
  if (DI.check(Log)) return () => {};
  DI.register(TestLog).as(Log as never);
  TestLog.clear();
  return () => {
    DI.uncache(TestLog);
    DI.unregister(TestLog);
    TestLog.clear();
  };
}
