import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';

/** Stands in for the app's Log so DI-built sinks write here, not to the console. */
export class TestLog {
  static readonly lines: string[] = [];
  constructor(readonly Name: string = '') {}
  info(m: string): void {
    TestLog.lines.push(`info ${this.Name} ${m}`);
  }
  warn(m: string): void {
    TestLog.lines.push(`warn ${this.Name} ${m}`);
  }
}

export function useTestLog(): void {
  before(() => {
    DI.register(TestLog).as(Log as never);
  });
  beforeEach(() => {
    TestLog.lines.length = 0;
  });
  after(() => {
    DI.uncache(TestLog);
    DI.unregister(TestLog);
  });
}
