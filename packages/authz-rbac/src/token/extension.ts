import type { DecisionRequest, EvaluationContext, Principal } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';

import type { RbacExtension, RbacInput } from '../model/evaluate.js';
import type { RbacModelOptions } from '../model/model.js';
import { TokenRoleRules, isTokenPrincipal, loadTokenRoleRules } from './rules.js';

export interface TokenRoleExtensionDeps {
  /** Replaces authz.token (for tests). Default: loaded at init from the domain's container and the Configuration it resolves. */
  readonly rules?: TokenRoleRules | (() => Promise<TokenRoleRules>);
}

const NO_CONFIGURATION: Pick<Configuration, 'get'> = { get: <T>(_path: string | string[], dflt?: T) => dflt as T };

const TOKEN_ROLE_EXTENSION = Symbol('tokenRoleExtension');

/** Whether `e` came from {@link tokenRoleExtension}; RbacModel keeps exactly one of them, last. */
export function isTokenRoleExtension(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { [TOKEN_ROLE_EXTENSION]?: unknown })[TOKEN_ROLE_EXTENSION] === true;
}

/**
 * Applies `authz.token` to principals that authenticated with a token:
 * their roles become `ceiling.roles` (or every role, without one) cut by the excluded roles and the
 * TokenRolePolicy, and only assignments of those roles count. The roles come from the owner's own
 * assignments, so a token is never above its owner and a role the owner lacks grants nothing.
 */
export function tokenRoleExtension(_opts: RbacModelOptions, deps: TokenRoleExtensionDeps = {}): RbacExtension {
  let rules = deps.rules instanceof TokenRoleRules ? deps.rules : undefined;
  const extension: RbacExtension = {
    async init(ctx) {
      if (deps.rules instanceof TokenRoleRules) rules = deps.rules;
      else if (deps.rules) rules = await deps.rules();
      else {
        // The host resolves Configuration before any model init; outside it a model init must not start loading one.
        const configuration = ctx.container.isResolved(Configuration) ? ((await ctx.container.resolve(Configuration)) as Configuration) : NO_CONFIGURATION;
        rules = await loadTokenRoleRules(configuration, ctx.container);
      }
    },
    gather(request: DecisionRequest, _ctx: EvaluationContext, input: RbacInput): Partial<RbacInput> {
      if (!rules) throw new Error('rbac: the token role rules are used before the model init ran');
      // Under inherit delegation the models run as the delegate and the agent is the actor.
      if (rules.trivial || (!isTokenPrincipal(request.principal) && !isTokenPrincipal(request.actor))) return {};
      const principal = input.request.principal;
      const tokenRoles = ceilingRoleList(principal);
      const profile: unknown = principal.attributes?.profile;
      const allowed = rules.allowedRoles(principal, tokenRoles ?? input.roles.names, typeof profile === 'string' ? profile : undefined);
      const keep = new Set(allowed);
      // Narrowed ceiling.roles holds implied contributions to the same rule as assignments.
      const narrowed: Principal = Object.freeze({ ...principal, ceiling: Object.freeze({ ...(principal.ceiling ?? {}), roles: Object.freeze(allowed) }) });
      return { assignments: input.assignments.filter((a) => keep.has(a.role)), request: { ...input.request, principal: narrowed } };
    },
  };
  Object.defineProperty(extension, TOKEN_ROLE_EXTENSION, { value: true });
  return Object.freeze(extension);
}

/** The token's roles; null counts as absent, as in the engine's ceiling reader. */
function ceilingRoleList(principal: Principal): readonly string[] | undefined {
  const roles: unknown = principal.ceiling?.roles;
  if (roles === undefined || roles === null) return undefined;
  if (!Array.isArray(roles) || !roles.every((r) => typeof r === 'string')) throw new Error(`rbac: the ceiling.roles of ${principal.type}:${principal.id} is not a list of role names`);
  return roles;
}
