import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';

/**
 * Mocha hooks for a describe whose suites run on the kit's host harness, in any file order. DI keys types by class
 * name, so once a suite has registered and resolved users' own TestConfiguration, the kit's TestConfiguration resolves
 * to that cached instance and `installHost()` fails. Call it before `runBehaviour` in the describe: it takes the root's
 * Configuration registrations and resolved instances out before the suites and puts them back after.
 */
export function useKitConfiguration(): void {
  const kept = new Map<string, unknown[]>();
  let registered: unknown[] = [];
  const registrations = () => (DI.RootContainer.Registry as unknown as { registry: Map<string, unknown[]> }).registry.get('Configuration');

  before(() => {
    const cache = DI.RootContainer.Cache;
    const keys = new Set<string>(['Configuration']);
    for (const inst of cache.get(Configuration) ?? []) keys.add((inst as object).constructor.name);
    for (const key of keys) {
      const held = cache.get(key);
      if (held) kept.set(key, [...held]);
      DI.RootContainer.uncache(key);
    }
    const list = registrations();
    registered = list ? list.splice(0) : [];
  });

  after(() => {
    registrations()?.splice(0, Infinity, ...registered);
    for (const [key, held] of kept) for (const inst of held) DI.RootContainer.Cache.add(key, inst);
    kept.clear();
  });
}
