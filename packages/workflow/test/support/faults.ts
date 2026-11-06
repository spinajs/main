import { FaultInjector, type FaultPointName } from '@spinajs/durable';

const keyOf = (detail?: Record<string, unknown>): string => (typeof detail?.key === 'string' ? detail.key : '');

/** `crash: true` is the engine's contract for "this replica is dead". */
export class TestCrash extends Error {
  public readonly crash = true;
  constructor(point: string) {
    super(`simulated crash at ${point}`);
    this.name = 'TestCrash';
  }
}

/** Registered for the whole process (DI keeps registrations); inert until a test arms `rule` or `failure`. */
export class TestFaults extends FaultInjector {
  public static rule: ((point: FaultPointName, detail?: Record<string, unknown>) => boolean) | undefined;
  /** A plain (non-crash) error to throw at a point: a database that is away, a disk that is full. */
  public static failure: ((point: FaultPointName, detail?: Record<string, unknown>) => Error | undefined) | undefined;
  public static hits: string[] = [];

  public static reset(): void {
    TestFaults.rule = undefined;
    TestFaults.failure = undefined;
    TestFaults.hits = [];
  }

  /** Crashes the first time `point` is hit for a key that starts with `keyPrefix`. */
  public static crashOnce(point: FaultPointName, keyPrefix = ''): void {
    let fired = false;
    TestFaults.rule = (p, detail) => {
      if (fired || p !== point || !keyOf(detail).startsWith(keyPrefix)) return false;
      fired = true;
      return true;
    };
  }

  public point(name: FaultPointName, detail?: Record<string, unknown>): void {
    TestFaults.hits.push(`${name} ${keyOf(detail)}`.trim());
    const failure = TestFaults.failure?.(name, detail);
    if (failure) throw failure;
    if (TestFaults.rule?.(name, detail)) throw new TestCrash(name);
  }
}
