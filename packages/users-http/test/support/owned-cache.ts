import { DI } from '@spinajs/di';

/** What the test apps resolve into the root cache; a sibling suite may have left them behind. */
export const WORLD_KEYS = ['Configuration', 'UsersHttpAppConfiguration', 'Orm', 'DefaultAuthzService', 'AuthzService', 'DefaultSessionIssuer', 'SessionIssuer', 'MemorySessionStore', 'AuthnImpersonationService', 'FreshAuthCheck', 'DefaultAuthnService', 'AuthnService', 'StrategyRegistry', 'UsersHttpTestRbac', 'RbacService'];

const cached = (): string[] => [...new Set([...DI.RootContainer.Cache].map((e) => e.key as unknown).filter((k): k is string => typeof k === 'string'))];

/**
 * The root cache entries one suite owns: what its tests resolve after `begin()`. `reset()` drops those and nothing
 * else, so a suite never wipes what another one (or http's own bootstrap) put in the root cache.
 */
export function ownedCache() {
  let base = new Set<string>();

  return {
    begin(): void {
      for (const key of WORLD_KEYS) DI.RootContainer.uncache(key);
      base = new Set(cached());
    },
    reset(): void {
      for (const key of cached()) {
        if (!base.has(key)) DI.RootContainer.uncache(key);
      }
    },
  };
}
