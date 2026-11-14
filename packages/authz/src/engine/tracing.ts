import type { Attributes } from '@opentelemetry/api';
import { SpinaAttr } from '@spinajs/tracing';

import type { Decision } from '../contracts/decision.js';
import { principalKey } from '../contracts/principal.js';
import { resourceKey } from '../contracts/resource.js';

export const CHECK_SPAN = 'authz.check';
export const EXPLAIN_SPAN = 'authz.explain';

/**
 * Enough to rebuild the explain request from the span alone (Studio "explain from trace"). The principal is the
 * effective one (after runAs / onBehalfOf); the requester goes to `spina.principal.actor` when it differs.
 */
export function decisionAttributes(decision: Decision, cached: boolean): Attributes {
  const attributes: Attributes = {
    [SpinaAttr.AuthzPermission]: decision.permission,
    [SpinaAttr.AuthzResource]: resourceKey(decision.resource),
    [SpinaAttr.PrincipalId]: principalKey(decision.principal),
    [SpinaAttr.AuthzAllowed]: decision.allowed,
    [SpinaAttr.AuthzCached]: cached,
  };
  if (decision.actor) attributes[SpinaAttr.PrincipalActor] = principalKey(decision.actor);
  if (decision.reason) attributes[SpinaAttr.AuthzReason] = decision.reason.code;
  return attributes;
}
