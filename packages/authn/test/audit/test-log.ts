import { DI, NewInstance } from '@spinajs/di';
import { Log } from '@spinajs/log-common';

export interface TestLogEntry {
  readonly level: 'info' | 'warn';
  readonly logger: string;
  readonly message: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

/** Stands in for the app's Log so DI-built services write here, not to the console. One instance per resolve, like FrameworkLogger. */
@NewInstance()
export class TestLog {
  static readonly entries: TestLogEntry[] = [];
  static readonly lines: string[] = [];

  static clear(): void {
    TestLog.entries.length = 0;
    TestLog.lines.length = 0;
  }

  static of(logger: string): TestLogEntry[] {
    return TestLog.entries.filter((e) => e.logger === logger);
  }

  constructor(readonly Name: string = '') {}

  info(first: unknown, ...rest: unknown[]): void {
    this.write('info', first, rest);
  }

  warn(first: unknown, ...rest: unknown[]): void {
    this.write('warn', first, rest);
  }

  // The Log overloads: (message, ...args) or (fields, message?, ...args).
  private write(level: TestLogEntry['level'], first: unknown, rest: unknown[]): void {
    const fields = first !== null && typeof first === 'object' ? (first as Record<string, unknown>) : undefined;
    const [format, ...args] = fields ? rest : [first, ...rest];
    const message = String(format ?? '').replace(/%s/g, () => String(args.shift()));
    TestLog.entries.push({ level, logger: this.Name, message, ...(fields ? { fields } : {}) });
    TestLog.lines.push(`${level} ${this.Name} ${message}`);
  }
}

export function useTestLog(): void {
  before(() => {
    DI.register(TestLog).as(Log as never);
  });
  beforeEach(() => {
    TestLog.clear();
  });
  after(() => {
    DI.uncache(TestLog);
    DI.unregister(TestLog);
  });
}
