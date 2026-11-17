import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { UNATTENDED, principalKey } from '@spinajs/principal';

import { AUDIT_WIDTHS } from './contracts.js';
import { isRecord } from './guards.js';

const TRACE_ID = /^[0-9a-f]{32}$/;

export abstract class AuditContext {
  abstract actor(): string;
  abstract onBehalfOf(): string | undefined;
  abstract traceId(): string | undefined;
  abstract origin(): string | undefined;
  tenant(): string | undefined {
    return undefined;
  }
  decisionId(): string | undefined {
    return undefined;
  }
  idempotencyKey(): string | undefined {
    return undefined;
  }
}

type Ref = Record<string, unknown> & { readonly type: string; readonly id: string | number };

const isRef = (v: unknown): v is Ref => isRecord(v) && typeof v.type === 'string' && (typeof v.id === 'string' || typeof v.id === 'number');
const keyOf = (ref: Ref): string => principalKey({ type: ref.type, id: String(ref.id) }).slice(0, AUDIT_WIDTHS.actor);

// Resolved on every call, never cached: see packages/log/src/context.ts.
const store = (): Record<string, unknown> | undefined => (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<Record<string, unknown>>).getStore();

function effectivePrincipal(): Ref | undefined {
  const s = store();
  const authz: unknown = s?.Principal;
  if (isRef(authz)) return authz;
  const authn: unknown = s?.AuthnPrincipal;
  return isRef(authn) ? authn : undefined;
}

/** The request store http, authn and authz share: authz's `Principal` (runAs included), else authn's `AuthnPrincipal`; http's `traceId`; the client address. */
export class AmbientAuditContext extends AuditContext {
  actor(): string {
    const principal = effectivePrincipal();
    return principal === undefined ? principalKey(UNATTENDED) : keyOf(principal);
  }

  onBehalfOf(): string | undefined {
    const principal = effectivePrincipal();
    const impersonation: unknown = principal?.authn;
    const impersonator: unknown = isRecord(impersonation) ? impersonation.impersonator : undefined;
    if (isRef(impersonator)) return keyOf(impersonator);
    const delegator: unknown = principal?.onBehalfOf;
    if (isRef(delegator)) return keyOf(delegator);
    // Under runAs the effective principal is the elevated one; authn's is still the signed-in person.
    const authn: unknown = store()?.AuthnPrincipal;
    return principal !== undefined && isRef(authn) && keyOf(authn) !== keyOf(principal) ? keyOf(authn) : undefined;
  }

  traceId(): string | undefined {
    const id = store()?.traceId;
    return typeof id === 'string' && TRACE_ID.test(id) ? id : undefined;
  }

  origin(): string | undefined {
    const s = store();
    const address = typeof s?.ClientIp === 'string' ? s.ClientIp : s?.realIp;
    return typeof address === 'string' && address !== '' ? address.slice(0, AUDIT_WIDTHS.origin) : undefined;
  }
}

const AMBIENT = new AmbientAuditContext();

/** The `AuditContext` registered in the lineage of `container`, else the ambient one. */
export function auditContext(container: IContainer = DI.RootContainer): AuditContext {
  return container.hasRegistered(AuditContext) ? container.resolve(AuditContext) : AMBIENT;
}
