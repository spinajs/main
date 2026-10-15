import { GLOBAL, resourceKey } from '@spinajs/authz';

import type { LoadedPolicy } from './policies.js';

/**
 * Why the policy's answer can differ from row to row, or undefined when it is decided by the principal,
 * the actor and env alone (design §7, lane L10 decision 1).
 */
export function rowDependence(p: LoadedPolicy): string | undefined {
  const scope = p.policy.scope;
  if (scope && scope.type !== GLOBAL.type) return `applies under ${resourceKey(scope)} only`;
  const facts = p.when?.facts;
  if (!facts) return undefined;
  if (facts.roots.includes('resource')) return 'reads resource.* in its condition';
  const node = facts.scopeTypes.find((t) => t !== GLOBAL.type);
  if (node !== undefined) return `reads scope.${node}.* in its condition`;
  return undefined;
}

export const notListFilterable = (p: LoadedPolicy, why: string, permission: string, type: string): string => `${p.where} (source: ${p.policy.source}) ${why}, so ${permission} on ${JSON.stringify(type)} is not list-filterable`;
