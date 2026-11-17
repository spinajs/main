import { AuthzService, readDomainConfig } from '@spinajs/authz';
import type { AuthzDomains, PermissionConfig } from '@spinajs/authz';
import { BadRequest } from '@spinajs/exceptions';

import type { StudioAuthzDomain, StudioAuthzPermission } from '../contracts/index.js';
import { truncate } from '../span.js';

export const MAX_DOMAIN_LIMIT = 1000;

export function domainParam(domains: AuthzDomains, raw: unknown): string {
  const name = raw === undefined || raw === '' ? 'root' : raw;
  if (typeof name !== 'string' || !domains.names().includes(name)) throw new BadRequest(`unknown authz domain ${String(raw)}`);
  return name;
}

/** The domain's own service when something already booted it; Studio never boots a domain the app did not use. */
export function bootedService(domains: AuthzDomains, name: string): AuthzService | undefined {
  const container = domains.container(name);
  if (!container.isResolved(AuthzService)) return undefined;
  const service: unknown = container.get(AuthzService);
  // Both lookups fall back to the parent containers: an unbooted child domain answers with its parent's service.
  return service instanceof AuthzService && service.domain === name ? service : undefined;
}

// The configuration is unvalidated where it is held in memory, so a value goes out only when it has its declared type.
const text = (value: unknown): string | undefined => (typeof value === 'string' ? truncate(value) : undefined);

function permissionOf(name: string, p: PermissionConfig): StudioAuthzPermission {
  const description = text(p.description);
  const types: unknown = p.types;
  return {
    name: truncate(name),
    ...(description === undefined ? {} : { description }),
    ...(Array.isArray(types) ? { types: types.filter((t): t is string => typeof t === 'string').map(truncate) } : {}),
  };
}

function describeOne(domains: AuthzDomains, authzTree: unknown, name: string): StudioAuthzDomain {
  const lineage = domains.lineage(name);
  const cfg = readDomainConfig(authzTree, lineage);
  const service = bootedService(domains, name);
  // The live lineage, not `cfg.parent`: a domain created in code has a parent its configuration need not name.
  const parent = lineage.length > 1 ? lineage[lineage.length - 2] : undefined;
  return {
    name,
    ...(parent === undefined ? {} : { parent }),
    models: service ? service.models().map((m) => truncate(m.name)) : [],
    algorithm: text(cfg.combine.default.algorithm) ?? '',
    typeAlgorithms: Object.fromEntries(Object.entries(cfg.combine.types ?? {}).map(([type, entry]) => [truncate(type), text(entry.algorithm) ?? ''])),
    permissions: Object.entries(cfg.permissions).map(([permission, p]) => permissionOf(permission, p)),
  };
}

/** The given domains (default: all, in creation order, root first); a domain whose configuration cannot be read carries the error. */
export function describeDomains(domains: AuthzDomains, authzTree: unknown, names: readonly string[] = domains.names()): StudioAuthzDomain[] {
  return names.map((name) => {
    try {
      return describeOne(domains, authzTree, name);
    } catch (e) {
      return { name, models: [], algorithm: '', typeAlgorithms: {}, permissions: [], error: truncate(e instanceof Error ? e.message : String(e)) };
    }
  });
}
