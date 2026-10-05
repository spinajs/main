import type { LinkDef, Principal, PrincipalRef } from '@spinajs/authz';

/** The deny code of a link principal's ceiling: an invalid, expired or out-of-scope link. */
export const LINK_INVALID = 'link_invalid';

/** The id of the principal of a token no link holds (the token never appears in it). */
export const UNRESOLVED_LINK_ID = 'unresolved';

/**
 * The companion a link principal may carry: the companion travels as a PrincipalRef, so anything
 * that narrows it beyond its assignments would be lost inside the link principal. Such a companion
 * is left out and the link gives its own access only:
 * - a `ceiling` of any kind (a role switch, token scopes or resources, an expiry);
 * - `onBehalfOf` (an agent or a delegated token: the answer must stay within the delegate's);
 * - a link principal (its assignments would join without its own ceiling).
 * Only the companion's subjects join: its attributes and authn facts do not reach conditions inside
 * the link scope, so a deny keyed on them (an ABAC `principal.attributes.*` deny, a rule
 * `subjects.when`, a `principal.authn.*` threshold) does not see the companion. A token user
 * always carries `ceiling.roles` (B24), so it opens a link with the link's access only.
 */
export function linkCompanion(companion: Principal | undefined): PrincipalRef | undefined {
  if (!companion || companion.ceiling !== undefined || companion.onBehalfOf !== undefined || companion.type === 'link') return undefined;
  return Object.freeze({ type: companion.type, id: companion.id });
}

/**
 * The principal of a share link (design §6.1.6): the link's own subject (its assignments are to
 * `link:<id>`), with the companion's subjects joined, inside the ceiling of the link's scope and
 * expiry. `link` null (unknown, revoked) gives `ceiling.resources: []`: every check denies
 * `link_invalid`, whoever carries it (B42). An expired link keeps its `expiresAt`, which the engine
 * judges at its own clock.
 */
export function linkPrincipalOf(link: LinkDef | null, id: string, companion?: Principal): Principal {
  const ref = linkCompanion(companion);
  const expiresAt = link?.expiresAt ? new Date(link.expiresAt.getTime()) : undefined;
  return Object.freeze({
    type: 'link',
    id: link?.id ?? id,
    authenticated: true,
    source: 'link',
    ...(ref ? { companions: Object.freeze([ref]) } : {}),
    ceiling: Object.freeze({ resources: Object.freeze(link ? [Object.freeze({ ...link.scope })] : []), ...(expiresAt ? { expiresAt } : {}), reason: LINK_INVALID }),
    attributes: Object.freeze({ ...(link?.attributes ?? {}) }),
  });
}
