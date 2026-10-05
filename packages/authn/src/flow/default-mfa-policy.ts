import { Container, Inject, Injectable, PerChildInstance } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';

import type { IdentityRef } from '../contracts/credentials.js';
import { RoleSource } from '../contracts/hooks.js';
import { MfaPolicy } from '../contracts/mfa.js';
import type { AuthnFacts } from '../contracts/principal.js';
import { PrincipalFactory } from '../contracts/service.js';
import { MfaStepRegistry } from './mfa-step-registry.js';

/**
 * Design §22.3: the steps of `authn.mfa.steps` the identity is enrolled in, for password logins only (D13: a key
 * challenge proves possession and an IdP does its own MFA). When none is enrolled, `force`, or a role of
 * `forceForRoles` (asked through RoleSource), requires the first configured step, so the pending session can only
 * enrol. Boot fails when forceForRoles has no RoleSource or PrincipalFactory to ask; the schema refuses force and
 * forceForRoles with no step to require.
 */
@PerChildInstance()
@Injectable(MfaPolicy)
@Inject(Container)
export class DefaultMfaPolicy extends MfaPolicy {
  @Config('authn.mfa.policy.force')
  protected Force: boolean;

  @Config('authn.mfa.policy.forceForRoles')
  protected ForceForRoles: string[];

  constructor(private readonly container: IContainer) {
    super();
  }

  public get force(): boolean {
    return this.Force === true;
  }

  public get forceForRoles(): readonly string[] {
    return this.ForceForRoles ?? [];
  }

  public resolve(): void {
    if (this.forceForRoles.length > 0) {
      for (const [type, name] of [
        [RoleSource, 'RoleSource'],
        [PrincipalFactory, 'PrincipalFactory'],
      ] as const) {
        if (!this.container.hasRegistered(type as unknown as Class<unknown>)) throw new InvalidOption(`authn.mfa.policy.forceForRoles needs a ${name} to read roles, and none is registered`);
      }
    }
    super.resolve();
  }

  public async required(id: IdentityRef, facts: Pick<AuthnFacts, 'method' | 'strategy'>): Promise<readonly string[]> {
    if (facts.method !== 'password') return [];
    const steps = (await this.container.resolve(MfaStepRegistry)).steps();
    const enrolled: string[] = [];
    for (const s of steps) if (await s.enrolled(id)) enrolled.push(s.name);
    if (enrolled.length > 0 || steps.length === 0) return enrolled;
    return (await this.forced(id, facts)) ? [steps[0].name] : [];
  }

  private async forced(id: IdentityRef, facts: Pick<AuthnFacts, 'method' | 'strategy'>): Promise<boolean> {
    if (this.force) return true;
    if (this.forceForRoles.length === 0) return false;
    try {
      const principals = (await this.container.resolve(PrincipalFactory as unknown as Class<PrincipalFactory>)) as PrincipalFactory;
      const principal = await principals.principalOf(id, { ...facts, assurance: 'aal1', mfa: [], authenticatedAt: new Date() }, {});
      const roles = await ((await this.container.resolve(RoleSource as unknown as Class<RoleSource>)) as RoleSource).rolesOf(principal);
      return roles.some((r) => this.forceForRoles.includes(r.role));
    } catch {
      // Fail closed: without the roles, ask for the step.
      return true;
    }
  }
}
