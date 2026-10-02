import { FakeClock } from '../fakes/clock.js';
import { bddOf, markPending, withCleanupErrors } from '../behaviour/runner.js';
import type { PendingLog } from '../behaviour/runner.js';
import type { TestThis } from '../behaviour/types.js';

export { bddOf };

/** Marks the running case pending in its title and the suite summary, then skips it, so a case never passes silently. */
export function pending(t: TestThis, reason: string, log?: PendingLog): never {
  markPending(t, reason, log);
  return t.skip();
}

/** Fresh subject and clock per case; dispose and uninstall run once on every exit path, and a dispose error never hides the case's own. */
export async function withSubject<S extends { dispose?(): Promise<void> }>(make: (k: { clock: FakeClock }) => S | Promise<S>, fakeDate: boolean | undefined, body: (subject: S, clock: FakeClock) => Promise<void>): Promise<void> {
  const clock = new FakeClock();
  if (fakeDate !== false) {
    clock.install();
  }
  let subject: S | undefined;
  let failed = false;
  let primary: unknown;
  try {
    subject = await make({ clock });
    await body(subject, clock);
  } catch (e) {
    failed = true;
    primary = e;
    throw e;
  } finally {
    const cleanup: unknown[] = [];
    try {
      await subject?.dispose?.();
    } catch (e) {
      cleanup.push(e);
    }
    clock.uninstall();
    if (cleanup.length > 0) {
      // eslint-disable-next-line no-unsafe-finally
      throw withCleanupErrors(failed ? primary : undefined, cleanup);
    }
  }
}
