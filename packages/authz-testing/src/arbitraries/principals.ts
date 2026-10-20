import * as fc from 'fast-check';

import { SYSTEM, UNATTENDED } from '@spinajs/authz';
import type { Ceiling, Principal, PrincipalRef, ResourceRef } from '@spinajs/authz';

import { agentPrincipal, groupPrincipal, linkPrincipal, servicePrincipal, userPrincipal, withCeiling } from '../principals.js';
import { DEFAULT_ROLES, DEFAULT_TYPES, dateInRange, fromPool, idOf, scopeRef, sparse, typeOf, withOdds } from './common.js';
import type { NowOption, RefOptions } from './common.js';
import { permissionGlob } from './permissions.js';

export interface ResourceRefOptions {
  readonly types?: readonly string[];
  readonly ids?: readonly string[];
  /** Allow refs without an id (type-level). Default true. */
  readonly typeLevel?: boolean;
}

export function resourceRef(opts: ResourceRefOptions = {}): fc.Arbitrary<ResourceRef> {
  const withId = scopeRef(opts);
  if (opts.typeLevel === false) return withId;
  return fc.oneof({ weight: 4, arbitrary: withId }, { weight: 1, arbitrary: typeOf(opts.types).map((type): ResourceRef => ({ type })) });
}

export type PrincipalKind = 'user' | 'service' | 'group' | 'link' | 'agent' | 'system' | 'unattended';

export interface PrincipalRefOptions {
  /** Default user, service, group and link. */
  readonly kinds?: readonly string[];
  readonly ids?: readonly string[];
}

export function principalRef(opts: PrincipalRefOptions = {}): fc.Arbitrary<PrincipalRef> {
  return fc.record({ type: fromPool(opts.kinds ?? ['user', 'service', 'group', 'link'], 'kinds'), id: idOf(opts.ids) });
}

export interface CeilingOptions extends RefOptions, NowOption {
  /** Role pool; `[]` leaves `roles` absent or empty. */
  readonly roles?: readonly string[];
  /** Permission pool; `[]` leaves `permissions` absent or empty. */
  readonly permissions?: readonly string[];
  readonly maxLength?: number;
}

/**
 * Each list field is absent (1 in 6), `[]` (1 in 6, covers nothing) or filled (4 in 6, restricts
 * nothing outside it); `expiresAt` and `reason` are present about a third of the time. Resources
 * always carry an id: what a type-level ref covers is not defined by the contract.
 */
export function ceiling(opts: CeilingOptions = {}): fc.Arbitrary<Ceiling> {
  const maxLength = opts.maxLength ?? 3;
  const list = <T>(item: fc.Arbitrary<T> | undefined): fc.Arbitrary<T[] | undefined> =>
    fc.oneof(
      { weight: 1, arbitrary: fc.constant(undefined) },
      { weight: 1, arbitrary: fc.constant([] as T[]) },
      ...(item ? [{ weight: 4, arbitrary: fc.array(item, { minLength: 1, maxLength }) }] : []),
    );
  const roles = opts.roles ?? DEFAULT_ROLES;
  const permissions = opts.permissions;
  return sparse(
    {
      roles: list(roles.length ? fromPool(roles) : undefined),
      permissions: list(permissions?.length === 0 ? undefined : permissionGlob(permissions ? { pool: permissions } : {})),
      resources: list(resourceRef({ ...opts, typeLevel: false })),
      expiresAt: dateInRange(opts.now),
      reason: fromPool(['ceiling', 'out_of_scope', 'link_invalid']),
    },
    { roles: 100, permissions: 100, resources: 100, expiresAt: 30, reason: 30 },
  ) as unknown as fc.Arbitrary<Ceiling>;
}

export interface PrincipalOptions extends RefOptions, NowOption {
  /** Default user, service, group, link and agent; 'system' and 'unattended' are the frozen singletons, offered only when named. */
  readonly kinds?: readonly PrincipalKind[];
  /** true: always a ceiling, false: never, absent: about a third of the time. Links always carry one. */
  readonly ceiling?: boolean;
  readonly roles?: readonly string[];
  readonly permissions?: readonly string[];
  /** Attribute names; values are small strings, numbers, booleans or string lists. */
  readonly attributes?: readonly string[];
}

const attributeValue = (): fc.Arbitrary<unknown> => fc.oneof(fromPool(['a', 'b', 'c']), fc.integer({ min: 0, max: 3 }), fc.boolean(), fc.array(fromPool(['a', 'b', 'c']), { maxLength: 3 }));

/** Principals built with the kit's own builders, so they are frozen like the engine expects. */
export function principal(opts: PrincipalOptions = {}): fc.Arbitrary<Principal> {
  const kinds = opts.kinds ?? (['user', 'service', 'group', 'link', 'agent'] as const);
  const ceilingArb = ceiling(opts);
  const ceilingChoice = opts.ceiling === true ? ceilingArb : opts.ceiling === false ? fc.constant(undefined) : withOdds(ceilingArb, 33);
  const attrNames = opts.attributes ?? ['pool', 'tier', 'dept'];
  const attributes = (attrNames.length ? fc.dictionary(fromPool(attrNames), attributeValue(), { maxKeys: 3 }) : fc.constant({})) as fc.Arbitrary<Record<string, unknown>>;
  const id = idOf(opts.ids);
  const scope = scopeRef({ types: opts.types ?? DEFAULT_TYPES, ids: opts.ids });

  const delegate = fc.tuple(id, attributes).map(([i, a]) => userPrincipal(i, { attributes: a }));

  const build = (kind: PrincipalKind): fc.Arbitrary<Principal> => {
    switch (kind) {
      case 'system':
        return fc.constant(SYSTEM);
      case 'unattended':
        return fc.constant(UNATTENDED);
      case 'link':
        return fc.tuple(id, attributes, ceilingChoice, fc.array(scope, { minLength: 1, maxLength: 2 }), withOdds(dateInRange(opts.now), 50)).map(([i, a, c, scopes, expiresAt]) => linkPrincipal(i, { scope: scopes, attributes: a, expiresAt, ...(c ? { permissions: c.permissions } : {}) }));
      case 'agent':
        return fc.tuple(id, attributes, ceilingChoice, delegate, fromPool(['inherit', 'intersect'] as const)).map(([i, a, c, owner, delegation]) => agentPrincipal(i, owner, { attributes: a, delegation, ceiling: c }));
      default: {
        const make = kind === 'user' ? userPrincipal : kind === 'service' ? servicePrincipal : groupPrincipal;
        return fc.tuple(id, attributes, ceilingChoice).map(([i, a, c]) => {
          const p = make(i, { attributes: a });
          return c ? withCeiling(p, c) : p;
        });
      }
    }
  };

  if (kinds.length === 0) throw new Error('arbitraries: kinds is empty');
  return fc.oneof(...kinds.map(build));
}
