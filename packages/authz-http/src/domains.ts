import { DI, isFactory } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { AuthzConfigError, AuthzDomains, AuthzService, DecisionAudit, DefaultAuthzDomains, readDomainConfig } from '@spinajs/authz';

/** The booted AuthzService of a domain; `authz()` would throw before the domain's first resolve. */
export async function domainService(domain: string): Promise<AuthzService> {
  if (domain === 'root') {
    return (await DI.resolve(AuthzService)) as AuthzService;
  }
  const domains = (await DI.resolve(AuthzDomains)) as AuthzDomains;
  return domains.service(domain);
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
 * `audit.unscoped` is on. The host keeps its audit to itself, so this reads the same config.
 */
export async function auditUnscoped(domain: string, entry: AuditEntry): Promise<void> {
  const domains = await DI.resolve(AuthzDomains);
  // A bypass must not go unaudited, and only the host's AuthzDomains tells a domain's config lineage.
  if (!(domains instanceof DefaultAuthzDomains)) throw new AuthzConfigError('@Unscoped needs the host AuthzDomains to audit the bypass');
  const configuration = DI.get(Configuration);
  const cfg = readDomainConfig((path) => configuration?.get(path), domains.lineage(domain));
  if (!cfg.audit.unscoped) return;
  const audit = await pickAudit(domains.container(domain), cfg.audit.service);
  await audit?.record(entry);
}
