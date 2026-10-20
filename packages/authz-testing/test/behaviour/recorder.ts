import type { MochaLike } from '../../src/index.js';

export interface RecordedTest {
  readonly title: string;
  /** Enclosing describe titles, outermost first. */
  readonly path: readonly string[];
  readonly fn?: () => Promise<void>;
}

export interface TestResult {
  readonly title: string;
  readonly state: 'passed' | 'failed' | 'pending';
  readonly error?: Error;
}

/** A MochaLike that records the suite tree, so runner semantics can be checked without a nested mocha. */
export function recorder() {
  const tests: RecordedTest[] = [];
  const suites: string[][] = [];
  const before: (() => Promise<void>)[] = [];
  const after: (() => Promise<void>)[] = [];
  const stack: string[] = [];

  const mocha: MochaLike = {
    describe(title, fn) {
      stack.push(title);
      suites.push([...stack]);
      fn();
      stack.pop();
    },
    it(title, fn) {
      tests.push({ title, path: [...stack], ...(fn ? { fn: () => fn.call(undefined) } : {}) });
    },
    before(fn) {
      before.push(fn);
    },
    after(fn) {
      after.push(fn);
    },
  };

  return {
    mocha,
    tests,
    suites,
    hooks: { before, after },
    /** Runs the recorded tests in order, between the before and after hooks. */
    async run(): Promise<TestResult[]> {
      for (const h of before) await h();
      const results: TestResult[] = [];
      for (const t of tests) {
        if (!t.fn) {
          results.push({ title: t.title, state: 'pending' });
          continue;
        }
        try {
          await t.fn();
          results.push({ title: t.title, state: 'passed' });
        } catch (e) {
          results.push({ title: t.title, state: 'failed', error: e as Error });
        }
      }
      for (const h of after) await h();
      return results;
    },
  };
}
