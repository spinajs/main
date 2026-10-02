import { FakeClock } from '../fakes/clock.js';
import type { BddApi, TestThis } from './bdd.js';

export const bddOf = (bdd?: BddApi): BddApi => bdd ?? (globalThis as unknown as BddApi);

/** Marks the running case pending in its title, then skips it, so a case never passes silently. */
export function pending(t: TestThis, reason: string): never {
  if (t.test) {
    t.test.title += ` [pending: ${reason}]`;
  }
  return t.skip();
}

/** Fresh subject and clock per case; dispose and uninstall run once on every exit path. */
export async function withSubject<S extends { dispose?(): Promise<void> }>(
  make: (k: { clock: FakeClock }) => S | Promise<S>,
  fakeDate: boolean | undefined,
  body: (subject: S, clock: FakeClock) => Promise<void>,
): Promise<void> {
  const clock = new FakeClock();
  if (fakeDate !== false) {
    clock.install();
  }
  let subject: S | undefined;
  try {
    subject = await make({ clock });
    await body(subject, clock);
  } finally {
    try {
      await subject?.dispose?.();
    } finally {
      clock.uninstall();
    }
  }
}
