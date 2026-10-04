import type { AuthnFacts, Ceiling, Principal } from '@spinajs/authz';
import type { laneSteps } from '@spinajs/authz-testing';

type TokenRequest = laneSteps.TokenRequest;
type TokenHandle = laneSteps.TokenHandle;

/** A token request of the kit, plus the 2.x profile a pat or service token may be pinned to. */
export interface TokenPrincipalRequest extends TokenRequest {
  readonly profile?: string;
}

/**
 * The principal the app resolves for a request bearing a token made from `req`, built as the authn
 * pipeline builds it. authz-rbac may not depend on `@spinajs/authn*` (plan §1 rule 10), so the real
 * TokenService, TokenStrategy and DefaultAuthnService (tested in authn-token/test/v3, A14, A15) do not
 * run here. Sources:
 * - `authn/src/contracts/token.ts`: TokenCreateOptions and TokenService.create refuse (invalid_scope)
 *   kind 'agent' without `scope.agent` or the reverse, and an agent token with roles or a profile.
 *   TokenValidation: a pat or service token yields the owner's identity, `ceiling` with only the parts
 *   the token sets (roles become `ceiling.roles`), the profile as `attributes.profile`. An agent token
 *   yields `{ type: 'agent', id: <token id> }`, a ceiling without roles and with reason 'out_of_scope',
 *   and `delegation: { onBehalfOf: owner, mode: 'inherit' }`. Without a RoleSource, roles the owner
 *   lacks are stored as given; the check drops them (B07).
 * - `authn/src/service/default-authn-service.ts` `principalOf`: facts `{ method: 'token', strategy:
 *   'token', assurance: 'aal1', mfa: [], authenticatedAt }`; the delegate comes from the same factory
 *   with the same facts and nothing else.
 * - `authn-testing/src/fakes/principals.ts` `RecordingPrincipalFactory`: `authenticated: true`,
 *   `source: 'token'`, `authn: facts`, `attributes: { ...extra.attributes, ...derived }`.
 * The owner is a world principal: its type, id and attributes (what the factory derives) are kept; its
 * own authn, ceiling and source are not, since a token request carries the token's.
 * @throws Error for a create the contract refuses, so the kit step fails loudly
 */
export function tokenPrincipal(req: TokenPrincipalRequest, tokenId: string, authenticatedAt: Date): Principal {
  const kind = req.kind ?? (req.scope?.agent ? 'agent' : 'pat');
  const agent = kind === 'agent';
  if (agent !== (req.scope?.agent === true)) throw new Error(`token: invalid_scope (kind '${kind}' with scope.agent ${String(req.scope?.agent)})`);
  if (agent && (req.roles !== undefined || req.profile !== undefined)) throw new Error('token: invalid_scope (an agent token takes no roles or profile)');

  const facts: AuthnFacts = { method: 'token', strategy: 'token', assurance: 'aal1', mfa: [], authenticatedAt };
  const of = (type: string, id: string, derived: Readonly<Record<string, unknown>>, extra: { ceiling?: Ceiling; onBehalfOf?: Principal; delegation?: 'inherit'; attributes?: Readonly<Record<string, unknown>> } = {}): Principal => ({
    type,
    id,
    authenticated: true,
    source: 'token',
    attributes: { ...extra.attributes, ...derived },
    authn: facts,
    ...(extra.ceiling ? { ceiling: extra.ceiling } : {}),
    ...(extra.onBehalfOf ? { onBehalfOf: extra.onBehalfOf } : {}),
    ...(extra.delegation ? { delegation: extra.delegation } : {}),
  });

  const limits: Ceiling = { ...(req.scope?.permissions ? { permissions: [...req.scope.permissions] } : {}), ...(req.scope?.resources ? { resources: [...req.scope.resources] } : {}) };
  const owner = req.owner;
  if (agent) return of('agent', tokenId, {}, { ceiling: { ...limits, reason: 'out_of_scope' }, onBehalfOf: of(owner.type, owner.id, owner.attributes), delegation: 'inherit' });
  const ceiling: Ceiling = { ...(req.roles ? { roles: [...req.roles] } : {}), ...limits };
  return of(owner.type, owner.id, owner.attributes, { ...(Object.keys(ceiling).length > 0 ? { ceiling } : {}), ...(req.profile !== undefined ? { attributes: { profile: req.profile } } : {}) });
}

/** The `token` lane handle: each token gets its own id, authenticated at the case clock's now. */
export function tokenHandle(clock: { now(): Date }): TokenHandle & { principal(req: TokenPrincipalRequest): Promise<Principal> } {
  let issued = 0;
  return { principal: async (req: TokenPrincipalRequest) => tokenPrincipal(req, `token-${++issued}`, clock.now()) };
}
