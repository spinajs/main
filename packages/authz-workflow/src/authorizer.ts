import { Config } from '@spinajs/configuration';
import { Autoinject, Injectable } from '@spinajs/di';
import { AuthzDomains, engineLog, isPermission, parsePermission } from '@spinajs/authz';
import type { AuthzLog, Decision, Principal, ResourceRef } from '@spinajs/authz';
import { parsePrincipalKey, type PrincipalRef } from '@spinajs/principal';
import { SignalAuthorizer } from '@spinajs/workflow';
import { SignalPrincipalFactory } from './principal.js';

// A conditional allow on one row cannot be settled here, as no row is loaded: only a definite one, or a type-level one, passes.
const passes = (d: Decision): boolean => d.allowed && (d.residual.op === 'true' || d.resource.id === undefined);

function resourceOf(permission: string, resource: Record<string, unknown> | undefined): ResourceRef | undefined {
  if (resource === undefined) return { type: parsePermission(permission).resource };
  const { type, id } = resource;
  if (typeof type !== 'string' || type === '' || (id !== undefined && typeof id !== 'string')) return undefined;
  return id === undefined ? { type } : { type, id };
}

/**
 * Decides a permissioned `waitForEvent` with `@spinajs/authz`, as the identity the signal was stamped with
 * (`principalKey`, written by workflow-http). Throwing is left to the engine: it keeps the event pending and asks again.
 */
@Injectable(SignalAuthorizer)
export class AuthzSignalAuthorizer extends SignalAuthorizer {
  @Config('authz.workflow.domain')
  protected Domain: string;

  @Autoinject(AuthzDomains)
  protected Domains: AuthzDomains;

  @Autoinject(SignalPrincipalFactory)
  protected Principals: SignalPrincipalFactory;

  protected Log: AuthzLog = engineLog('authz-workflow');

  public async authorize(principal: string | undefined, permission: string, resource: Record<string, unknown> | undefined, ctx: { instanceId: string; workflow: string; event: string }): Promise<boolean> {
    const ref = principal === undefined ? undefined : parsePrincipalKey(principal);
    if (!ref) return false;
    // a wait may name any non-empty string; one that is not a permission can never be granted, and parsePermission would throw on it
    const target = isPermission(permission) ? resourceOf(permission, resource) : undefined;
    if (!target) {
      this.refused(ctx);
      return false;
    }
    return passes(await this.decide(await this.principalOf(ref), permission, target));
  }

  protected principalOf(ref: PrincipalRef): Promise<Principal> {
    return this.Principals.principalOf(ref);
  }

  protected async decide(principal: Principal, permission: string, resource: ResourceRef): Promise<Decision> {
    return (await this.Domains.service(this.Domain)).check({ principal, permission, resource });
  }

  protected refused(ctx: { workflow: string; event: string }): void {
    this.Log.warn({ workflow: ctx.workflow, event: ctx.event }, 'Workflow ${workflow} waits for ${event} with a permission that is not resource:action or a resource that is not { type, id? }; its signals are rejected');
  }
}
