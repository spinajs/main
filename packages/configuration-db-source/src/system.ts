import { DI } from '@spinajs/di';
import { authz, AuthzDomains, AuthzService, SYSTEM } from '@spinajs/authz';

export const POLL_REASON = 'config-poll';

const guarded = new Set<string>();

/**
 * Opts a domain in: from now on `asSystem` runs under `runAs(SYSTEM, 'config-poll')` for it.
 * Call it from an app that guards DbConfig (configuration-http does); without it queries run as in 2.x.
 */
export function requireSystemPrincipal(domain = 'root'): void {
  guarded.add(domain);
}

/** Test support: drops every opt-in. */
export function resetSystemPrincipal(): void {
  guarded.clear();
}

function resolvedService(domain: string): AuthzService | undefined {
  try {
    return authz(domain);
  } catch {
    return undefined;
  }
}

// A non-root domain exists only for the B09 harness (it runs in a child 'test' domain) and must already be resolved by the host.
// Never boots the service itself: booting it before the http server skips controllers (L5 boot rule 7).
function serviceOf(domain: string): Promise<AuthzService> {
  const ready = resolvedService(domain);
  if (ready) {
    return Promise.resolve(ready);
  }

  return new Promise<AuthzService>((resolve, reject) => {
    DI.once('di.resolved.AuthzService', () => {
      const load = async (): Promise<AuthzService> => (domain === 'root' ? ((await DI.resolve(AuthzService)) as AuthzService) : (await DI.resolve(AuthzDomains)).service(domain));
      load().then(resolve, reject);
    });
  });
}

/**
 * Runs `fn` as SYSTEM once the domain's AuthzService is resolved (when guarded), directly otherwise.
 * Query builders are thenables, hence PromiseLike.
 */
export async function asSystem<T>(fn: () => PromiseLike<T>, domain = 'root'): Promise<T> {
  if (!guarded.has(domain)) {
    return fn();
  }

  const service = await serviceOf(domain);
  return service.runAs(SYSTEM, POLL_REASON, async () => fn());
}
