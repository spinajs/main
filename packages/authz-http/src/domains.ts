import { DI } from '@spinajs/di';
import { AuthzConfigError, AuthzDomains, DecisionAudit, DefaultAuthzDomains, readDomainConfig } from '@spinajs/authz';
import type { DomainConfig } from '@spinajs/authz';

/** `domain`'s configuration as its service booted with it; before that boot, merged from `authz`, the caller's `authz` section. */
export function domainConfig(authz: unknown, domains: DefaultAuthzDomains, domain: string): DomainConfig {
  return domains.resolved(domain) ? domains.config(domain) : readDomainConfig(authz, domains.lineage(domain));
}

type AuditEntry = Parameters<DecisionAudit['record']>[0];

/** Records an `unscoped` bypass with the domain's DecisionAudit when the domain's `audit.unscoped` is on. */
export async function auditUnscoped(domain: string, entry: AuditEntry): Promise<void> {
  const domains = await DI.resolve(AuthzDomains);
  // A bypass must not go unaudited, and only the host's AuthzDomains knows what a domain's service picked.
  if (!(domains instanceof DefaultAuthzDomains)) throw new AuthzConfigError('@Unscoped needs the host AuthzDomains to audit the bypass');
  // An unscoped route may be the first request of its domain; the audit is the one its service picks at boot.
  await domains.service(domain);
  if (!domains.config(domain).audit.unscoped) return;
  await domains.audit(domain)?.record(entry);
}
