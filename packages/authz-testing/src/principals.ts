import type { AuthnFacts, Ceiling, Principal, PrincipalRef, ResourceRef } from '@spinajs/authz';

import { clonePlain, deepFreeze } from './util.js';

// Re-exported, never rebuilt: the engine recognises them by identity.
export { SYSTEM, UNATTENDED } from '@spinajs/authz';

export type PrincipalInit = Partial<Omit<Principal, 'type' | 'id'>>;

/**
 * Copies and freezes what the principal owns (attributes, ceiling, authn, companions).
 * `onBehalfOf` and `identity` stay the caller's objects; Dates stay Dates.
 */
export function sealPrincipal(p: Principal): Principal {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) if (v !== undefined) out[k] = v;
  out.attributes = deepFreeze(clonePlain(p.attributes ?? {}));
  if (p.ceiling) out.ceiling = sealCeiling(p.ceiling);
  if (p.authn) out.authn = Object.freeze({ ...p.authn, mfa: Object.freeze([...p.authn.mfa]) });
  if (p.companions) out.companions = Object.freeze(p.companions.map(toRef));
  return Object.freeze(out) as unknown as Principal;
}

function sealCeiling(c: Ceiling): Ceiling {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) if (v !== undefined) out[k] = v;
  if (c.roles) out.roles = Object.freeze([...c.roles]);
  if (c.permissions) out.permissions = Object.freeze([...c.permissions]);
  if (c.resources) out.resources = Object.freeze(c.resources.map((r) => Object.freeze({ ...r })));
  return Object.freeze(out) as unknown as Ceiling;
}

const toRef = (r: PrincipalRef): PrincipalRef => Object.freeze({ type: r.type, id: r.id });

const build = (type: string, id: string, defaults: Omit<PrincipalInit, 'attributes'>, init: PrincipalInit): Principal => sealPrincipal({ type, id, attributes: {}, authenticated: true, source: 'session', ...defaults, ...init });

export const userPrincipal = (id: string, init: PrincipalInit = {}): Principal => build('user', id, {}, init);

export const anonymousPrincipal = (id = 'anonymous', init: PrincipalInit = {}): Principal => build('anonymous', id, { authenticated: false, source: 'anonymous' }, init);

export const servicePrincipal = (id: string, init: PrincipalInit = {}): Principal => build('service', id, { source: 'token' }, init);

export const groupPrincipal = (id: string, init: PrincipalInit = {}): Principal => build('group', id, {}, init);

export interface LinkOptions extends PrincipalInit {
  /** Becomes `ceiling.resources`; the ceiling reason is 'link_invalid' (B38). */
  readonly scope: ResourceRef | readonly ResourceRef[];
  readonly expiresAt?: Date;
  readonly permissions?: readonly string[];
}

export function linkPrincipal(id: string, opts: LinkOptions): Principal {
  const { scope, expiresAt, permissions, ...init } = opts;
  const resources = Array.isArray(scope) ? scope : [scope as ResourceRef];
  return build('link', id, { source: 'link' }, { ...init, ceiling: { resources, permissions, expiresAt, reason: 'link_invalid' } });
}

export interface AgentOptions extends PrincipalInit {
  /** Default 'inherit' (D18: an agent acts as its delegate, B37). */
  readonly delegation?: 'intersect' | 'inherit';
  /** With either of these the ceiling is built here, reason 'out_of_scope' (B24). */
  readonly permissions?: readonly string[];
  readonly resources?: readonly ResourceRef[];
}

export function agentPrincipal(id: string, onBehalfOf: Principal, opts: AgentOptions = {}): Principal {
  const { delegation = 'inherit', permissions, resources, ...init } = opts;
  const ceiling = permissions || resources ? { permissions, resources, reason: 'out_of_scope' } : init.ceiling;
  return build('agent', id, { source: 'token' }, { ...init, onBehalfOf, delegation, ceiling });
}

export const withCeiling = (p: Principal, ceiling: Ceiling): Principal => sealPrincipal({ ...p, ceiling });

export const withAttributes = (p: Principal, attributes: Readonly<Record<string, unknown>>): Principal => sealPrincipal({ ...p, attributes: { ...p.attributes, ...attributes } });

export const withCompanions = (p: Principal, companions: readonly PrincipalRef[]): Principal => sealPrincipal({ ...p, companions });

/** Fixed defaults, not "now", so fixtures stay deterministic: password/local, no mfa, authenticatedAt = epoch; aal2 when mfa is non-empty. */
export function withAuthn(p: Principal, facts: Partial<AuthnFacts> = {}): Principal {
  const mfa = facts.mfa ?? [];
  return sealPrincipal({ ...p, authn: { method: 'password', strategy: 'local', assurance: mfa.length > 0 ? 'aal2' : 'aal1', mfa, authenticatedAt: new Date(0), ...facts } });
}
