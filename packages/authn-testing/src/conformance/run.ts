import type { FakeClock } from '../fakes/clock.js';
import { DEFAULT_CASE_TIMEOUT_MS, MOCHA_SLACK_MS, bddOf, cleanUp, markPending, startCaseClock, withCleanupErrors, withDeadline } from '../behaviour/runner.js';
import type { PendingLog } from '../behaviour/runner.js';
import type { TestThis } from '../behaviour/types.js';

export { bddOf };

// What pending() threw, so withSubject can tell a skip from a failure.
const skips = new Set<unknown>();

/** Marks the running case pending in its title and the suite summary, then skips it, so a case never passes silently. */
export function pending(t: TestThis, reason: string, log?: PendingLog): never {
  try {
    markPending(t, reason, log);
    return t.skip();
  } catch (e) {
    skips.add(e);
    throw e;
  }
}

/** Sets mocha's timeout above the case deadline (as executeCase does) and returns the deadline. */
export function caseTimeout(t: TestThis, timeoutMs: number = DEFAULT_CASE_TIMEOUT_MS): number {
  t.timeout(timeoutMs + MOCHA_SLACK_MS);
  return timeoutMs;
}

/**
 * Fresh subject and clock per case, bounded by its own deadline; dispose and uninstall run once on every exit path,
 * and a dispose error never hides the case's own.
 */
export async function withSubject<S extends { dispose?(): Promise<void> }>(make: (k: { clock: FakeClock }) => S | Promise<S>, fakeDate: boolean | undefined, body: (subject: S, clock: FakeClock) => Promise<void>, opts: { timeoutMs?: number; name?: string } = {}): Promise<void> {
  const clock = startCaseClock(undefined, fakeDate);
  let subject: S | undefined;
  let primary: unknown;
  let failed = false;
  try {
    await withDeadline(
      (async () => {
        subject = await make({ clock });
        await body(subject, clock);
      })(),
      opts.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS,
      opts.name ?? 'case',
    );
  } catch (e) {
    failed = !skips.delete(e);
    primary = e;
    throw e;
  } finally {
    const cleanup = await cleanUp([['dispose', subject?.dispose ? () => subject!.dispose!() : undefined]]);
    clock.uninstall();
    if (cleanup.length > 0) {
      // eslint-disable-next-line no-unsafe-finally
      throw withCleanupErrors(failed ? primary : undefined, cleanup, opts.name);
    }
  }
}
