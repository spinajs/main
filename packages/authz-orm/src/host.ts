import { AuthzDomains, DecisionAudit, DefaultAuthzDomains, authzStorage, configuredLineage, engineLog, readDomainConfig } from '@spinajs/authz';
import type { DomainConfig, HostLog, Principal, ResourceType } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI, ResolveType, isFactory } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';

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

/** The domain's container once the host created it, else the DI root. */
export function domainContainer(domain: string): IContainer {
  const d = hostDomains();
  return d !== undefined && d.names().includes(domain) ? d.container(domain) : DI.RootContainer;
}

/** The domain's config over its lineage: the host's lineage once it has created its domains, else the configured parents. */
export function domainConfig(domain: string): DomainConfig {
  const tree = DI.get(Configuration)?.get<unknown>(['authz']);
  const d = hostDomains();
  const lineage = d !== undefined && d.names().includes(domain) ? d.lineage(domain) : configuredLineage(tree, domain);
  return readDomainConfig(tree, lineage);
}

// As the host picks it: the one named in audit.service, else the last DecisionAudit registered.
async function auditOf(domain: string): Promise<DecisionAudit | undefined> {
  const container = domainContainer(domain);
  const name = domainConfig(domain).audit.service;
  if (name === undefined) return container.hasRegistered(DecisionAudit) ? ((await container.resolve(DecisionAudit)) as DecisionAudit) : undefined;
  const entry = container.Registry.getTypesChain(DecisionAudit)
    .filter((e) => !isFactory(e.type) && (e.type as { name?: string }).name === name)
    .pop();
  if (!entry) return undefined;
  const type = entry.type as Class<DecisionAudit>;
  const at = container.extractDescriptor(type).resolver === ResolveType.PerChildContainer ? container : entry.container;
  return (await at.resolve(type)) as DecisionAudit;
}

/** Fire and forget: auditing never fails the query. */
export function recordAudit(domain: string, record: AuditRecord): void {
  auditOf(domain)
    .then((audit) => audit?.record(record))
    .then(undefined, (e: unknown) => ormLog().error(`authz-orm: audit record failed: ${e instanceof Error ? e.message : String(e)}`));
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

let log: HostLog | undefined;

export function ormLog(): HostLog {
  return (log ??= engineLog('authz-orm'));
}
