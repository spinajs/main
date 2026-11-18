import { Bootstrapper, DI } from '@spinajs/di';

/**
 * Runs every registered bootstrapper whose class is not in `ran` yet, and adds it, until a pass finds none: a
 * bootstrapper may import a module that registers another. Classes are tracked rather than instances, so a list
 * resolved again after a cache clear does not run a bootstrapper twice. Two registrations that yield the same class
 * therefore run once; no package registers a bootstrapper that way.
 */
export async function runPendingBootstrappers(ran: Set<object>): Promise<void> {
  let found = true;

  while (found) {
    found = false;

    for (const b of DI.resolve(Array.ofType(Bootstrapper))) {
      if (ran.has(b.constructor)) {
        continue;
      }

      ran.add(b.constructor);
      found = true;
      await b.bootstrap();
    }
  }
}
