import { AUTHZ_AUDIT_SERVICE_KEY, AuthzDomains, DecisionAudit, DefaultAuthzDomains, authzStorage, configuredLineage, engineLog, pickNamed, readDomainConfig, thrownError } from '@spinajs/authz';
import type { DomainConfig, AuthzLog, Principal, ResourceType } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

const ROOT = 'root';

type AuditRecord = Parameters<DecisionAudit['record']>[0];

/** `authz.orm.domain`: the domain whose service plans lists and whose stores a delete cleans; default root. */
export function ormDomain(): string {
  const v = DI.get(Configuration)?.get<unknown>(['authz', 'orm', 'domain']);
  return typeof v === 'string' && v !== '' ? v : ROOT;
}

function hostDomains(): DefaultAuthzDomains | undefined {
  const d: unknown = DI.get(AuthzDomains);
  return d instanceof DefaultAuthzDomains ? d : undefined;
}

/** The host's AuthzDomains once `domain`'s service has booted; until then the boot picks do not exist. */
function bootedDomains(domain: string): DefaultAuthzDomains | undefined {
  const d = hostDomains();
  return d?.resolved(domain) !== undefined ? d : undefined;
}

/** The domain's container once the host created it, else the DI root. */
export function domainContainer(domain: string): IContainer {
  const d = hostDomains();
  return d !== undefined && d.names().includes(domain) ? d.container(domain) : DI.RootContainer;
}

/**
 * The domain's config as its service booted with it; before that boot, merged over the host's lineage once it has
 * created the domain, else over the configured parents.
 */
export function domainConfig(domain: string): DomainConfig {
  const booted = bootedDomains(domain);
  if (booted) return booted.config(domain);
  const tree = DI.get(Configuration)?.get<unknown>(['authz']);
  const d = hostDomains();
  const lineage = d !== undefined && d.names().includes(domain) ? d.lineage(domain) : configuredLineage(tree, domain);
  return readDomainConfig(tree, lineage);
}

// The audit the domain's service picked at boot; before that boot, picked the way the host picks it.
async function auditOf(domain: string): Promise<DecisionAudit | undefined> {
  const booted = bootedDomains(domain);
  if (booted) return booted.audit(domain);
  return pickNamed(domainContainer(domain), DecisionAudit, domainConfig(domain).audit.service, AUTHZ_AUDIT_SERVICE_KEY, 'authz-orm');
}

/** The time on the domain's clock once its service has booted, else the system time. */
export function domainNow(domain: string): Date {
  return bootedDomains(domain)?.clock(domain).now() ?? new Date();
}

/** Fire and forget: auditing never fails the query. */
export function recordAudit(domain: string, record: AuditRecord): void {
  auditOf(domain)
    .then((audit) => audit?.record(record))
    .then(undefined, (e: unknown) => ormLog().error({ error: thrownError(e) }, 'authz-orm: audit record failed'));
}

/** A `.unscoped(reason)` query, audited when `authz.audit.unscoped` is on. */
export function auditUnscoped(domain: string, principal: Principal, reason: string, type: ResourceType): void {
  if (!domainConfig(domain).audit.unscoped) return;
  recordAudit(domain, { kind: 'unscoped', principal: { type: principal.type, id: principal.id }, reason, resource: { type } });
}

/** The reason of a route's `@Unscoped(reason)` (authz-http) for this request, if any. */
export function storageUnscoped(): string | undefined {
  const reason = authzStorage().getStore()?.Unscoped;
  return typeof reason === 'string' && reason !== '' ? reason : undefined;
}

let log: AuthzLog | undefined;

export function ormLog(): AuthzLog {
  return (log ??= engineLog('authz-orm'));
}
