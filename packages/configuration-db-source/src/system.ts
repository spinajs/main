import { DI } from '@spinajs/di';
import { authz, AuthzDomains, AuthzService, SYSTEM } from '@spinajs/authz';
import { InternalLogger } from '@spinajs/internal-logger';

export const POLL_REASON = 'config-poll';

const guarded = new Set<string>();

/** How long a guarded app waits for the host (the http server) to boot the root service before booting it itself. */
let bootWaitMs = 15_000;

/** Test support. */
export function setBootWait(ms: number): void {
  bootWaitMs = ms;
}

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
// The root service is normally booted by the http server after it registered the controllers (L5 boot rule 7), so it is only awaited.
// An app without an http server (worker, CLI) never boots it: after the bounded wait this boots it, with a warning.
function serviceOf(domain: string): Promise<AuthzService> {
  const ready = resolvedService(domain);
  if (ready) {
    return Promise.resolve(ready);
  }

  return new Promise<AuthzService>((resolve, reject) => {
    let done = false;
    const load = async (): Promise<AuthzService> => (domain === 'root' ? ((await DI.resolve(AuthzService)) as AuthzService) : (await DI.resolve(AuthzDomains)).service(domain));
    const go = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      load().then(resolve, reject);
    };
    const timer = setTimeout(() => {
      if (domain === 'root') {
        InternalLogger.warn(`AuthzService not booted ${bootWaitMs} ms after start (no http server?); booting it for the configuration source`, 'configuration-db-source');
        go();
      }
    }, bootWaitMs);
    timer.unref();
    DI.once('di.resolved.AuthzService', go);
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
