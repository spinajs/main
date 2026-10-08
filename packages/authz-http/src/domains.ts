import { DI, isFactory } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { AuthzConfigError, AuthzDomains, AuthzService, DecisionAudit, DefaultAuthzDomains, readDomainConfig } from '@spinajs/authz';
import type { DomainConfig } from '@spinajs/authz';

/** The booted AuthzService of a domain; `authz()` would throw before the domain's first resolve. */
export async function domainService(domain: string): Promise<AuthzService> {
  if (domain === 'root') {
    return (await DI.resolve(AuthzService)) as AuthzService;
  }
  const domains = (await DI.resolve(AuthzDomains)) as AuthzDomains;
  return domains.service(domain);
}

/** `domain`'s configuration merged over its lineage, from `authz`, the caller's `authz` section. */
export function domainConfig(authz: unknown, domains: DefaultAuthzDomains, domain: string): DomainConfig {
  return readDomainConfig(authz, domains.lineage(domain));
}

type AuditEntry = Parameters<DecisionAudit['record']>[0];

// Mirrors how the host picks a domain's DecisionAudit (authz.audit.service, else the registered one).
async function pickAudit(container: IContainer, service: string | undefined): Promise<DecisionAudit | undefined> {
  if (service === undefined) {
    return container.hasRegistered(DecisionAudit) ? ((await container.resolve(DecisionAudit)) as DecisionAudit) : undefined;
  }
  const entry = container.Registry.getTypesChain(DecisionAudit)
    .filter((e) => !isFactory(e.type) && (e.type as Class<unknown>).name === service)
    .pop();
  return entry ? ((await entry.container.resolve(entry.type as Class<DecisionAudit>)) as DecisionAudit) : undefined;
}

/**
 * Records an `unscoped` bypass with the domain's DecisionAudit when the domain's
 * `audit.unscoped` is on. The host keeps its audit to itself, so this merges the same `authz` section.
 */
export async function auditUnscoped(authz: unknown, domain: string, entry: AuditEntry): Promise<void> {
  const domains = await DI.resolve(AuthzDomains);
  // A bypass must not go unaudited, and only the host's AuthzDomains tells a domain's config lineage.
  if (!(domains instanceof DefaultAuthzDomains)) throw new AuthzConfigError('@Unscoped needs the host AuthzDomains to audit the bypass');
  const cfg = domainConfig(authz, domains, domain);
  if (!cfg.audit.unscoped) return;
  const audit = await pickAudit(domains.container(domain), cfg.audit.service);
  await audit?.record(entry);
}
