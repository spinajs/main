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

const selfBootWarned = new Set<string>();

// A refused boot is retried on every poll, so it recovers once e.g. migrate-up created the tables; only a new cause is logged again.
const lastRefusal = new Map<string, string>();
const reportedRefusals = new WeakSet<object>();

/** Test support: drops every opt-in. */
export function resetSystemPrincipal(): void {
  guarded.clear();
  selfBootWarned.clear();
  lastRefusal.clear();
}

/** True for a boot refusal `asSystem` already logged; callers skip their own error line for it. */
export function isReportedBootRefusal(err: unknown): boolean {
  return typeof err === 'object' && err !== null && reportedRefusals.has(err);
}

function reportRefusal(domain: string, err: unknown): void {
  const cause = err instanceof Error ? err.message : String(err);
  if (lastRefusal.get(domain) !== cause) {
    lastRefusal.set(domain, cause);
    InternalLogger.error({ error: err, domain }, 'AuthzService of domain ${domain} refused to boot for the configuration source', 'configuration-db-source');
  }
  if (typeof err === 'object' && err !== null) reportedRefusals.add(err);
}

function resolvedService(domain: string): AuthzService | undefined {
  try {
    return authz(domain);
  } catch {
    return undefined;
  }
}

/** Per domain, the one wait every query shares while its service is not resolved; dropped once it settles, so a service disposed later is never handed out from it. */
const waits = new Map<string, Promise<AuthzService>>();

function serviceOf(domain: string): Promise<AuthzService> {
  const ready = resolvedService(domain);
  if (ready) {
    return Promise.resolve(ready);
  }

  let pending = waits.get(domain);
  if (!pending) {
    const wait = waitForService(domain).finally(() => {
      if (waits.get(domain) === wait) {
        waits.delete(domain);
      }
    });
    waits.set(domain, wait);
    pending = wait;
  }

  return pending;
}

// A non-root domain exists only for the B09 harness (it runs in a child 'test' domain) and must already be resolved by the host.
// The root service is normally booted by the http server after it registered the controllers (L5 boot rule 7), so it is only awaited.
// An app without an http server (worker, CLI) never boots it: after the bounded wait this boots it, with a warning.
function waitForService(domain: string): Promise<AuthzService> {
  return new Promise<AuthzService>((resolve) => {
    const load = async (): Promise<AuthzService> => (domain === 'root' ? ((await DI.resolve(AuthzService)) as AuthzService) : (await DI.resolve(AuthzDomains)).service(domain));
    const go = () => {
      clearTimeout(timer);
      DI.off('di.resolved.AuthzService', go);
      resolve(
        load().then(
          (service) => {
            lastRefusal.delete(domain);
            return service;
          },
          (err: unknown) => {
            reportRefusal(domain, err);
            throw err;
          },
        ),
      );
    };
    const timer = setTimeout(() => {
      if (domain === 'root') {
        if (!selfBootWarned.has(domain)) {
          selfBootWarned.add(domain);
          InternalLogger.warn({ bootWaitMs }, 'AuthzService not booted ${bootWaitMs} ms after start (no http server?); booting it for the configuration source', 'configuration-db-source');
        }
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

/** Settles once `asSystem` can run for the domain without waiting; at once when the domain is not guarded. */
export async function systemReady(domain = 'root'): Promise<void> {
  if (guarded.has(domain)) {
    await serviceOf(domain);
  }
}
