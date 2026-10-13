import { Container, Inject, Injectable, PerChildInstance } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { AutoinjectService, Config } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';

import type { IdentityRef } from '../contracts/credentials.js';
import { RoleSource } from '../contracts/hooks.js';
import { MfaPolicy, MfaStep } from '../contracts/mfa.js';
import type { AuthnFacts } from '../contracts/principal.js';
import { PrincipalFactory } from '../contracts/service.js';
import { MfaEnrolmentMismatch, MfaEnrolments, MfaStepNotListed } from './mfa-enrolments.js';

/**
 * Design §22.3: the steps of `authn.mfa.steps` the identity is enrolled in, for password logins only (D13: a key
 * challenge proves possession and an IdP does its own MFA). When none is enrolled, every MfaEnrolments source of the
 * container lineage is asked, and any step a source reports refuses the login, forced or not, as the identity never
 * logs in with the password alone (§22.4, §22.18): MfaStepNotListed for a step the list leaves out, else
 * MfaEnrolmentMismatch (a listed step that does not see the stored enrolment). Otherwise `force`, or a role of
 * `forceForRoles` (asked through RoleSource), requires the first configured step, so the pending session can only
 * enrol. Boot fails when forceForRoles has no RoleSource or PrincipalFactory to ask; the schema refuses force and
 * forceForRoles with no step to require. The steps are those `authn.mfa.steps` lists when the policy is built.
 */
@PerChildInstance()
@Injectable(MfaPolicy)
@Inject(Container)
export class DefaultMfaPolicy extends MfaPolicy {
  @Config('authn.mfa.policy.force')
  protected Force: boolean;

  @Config('authn.mfa.policy.forceForRoles')
  protected ForceForRoles: string[];

  @AutoinjectService('authn.mfa.steps', MfaStep, { lineage: true, keyBy: 'name' })
  protected MfaSteps: Map<string, MfaStep>;

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
      const required: ReadonlyArray<readonly [Class<unknown>, string]> = [
        [RoleSource, 'RoleSource'],
        [PrincipalFactory, 'PrincipalFactory'],
      ];
      for (const [type, name] of required) {
        if (!this.container.hasRegistered(type)) throw new InvalidOption(`authn.mfa.policy.forceForRoles needs a ${name} to read roles, and none is registered`);
      }
    }
    super.resolve();
  }

  public async required(id: IdentityRef, facts: Pick<AuthnFacts, 'method' | 'strategy'>): Promise<readonly string[]> {
    if (facts.method !== 'password') return [];
    const steps = [...this.MfaSteps.values()];
    const enrolled: string[] = [];
    for (const s of steps) if (await s.enrolled(id)) enrolled.push(s.name);
    if (enrolled.length > 0) return enrolled;
    const stored = await this.storedSteps(id);
    const listed = new Set(steps.map((s) => s.name));
    const unlisted = stored.filter((name) => !listed.has(name));
    if (unlisted.length > 0) throw new MfaStepNotListed(unlisted);
    if (stored.length > 0) throw new MfaEnrolmentMismatch(stored);
    if (steps.length === 0) return [];
    return (await this.forced(id, facts)) ? [steps[0].name] : [];
  }

  /** A source that throws fails the login (the caller's policy_error). */
  private async storedSteps(id: IdentityRef): Promise<string[]> {
    const sources = await this.container.resolve(Array.chainOf(MfaEnrolments));
    const out = new Set<string>();
    // A resolve of the abstract base itself leaves an instance of it in the chain; it is no source.
    for (const source of sources.filter((s) => s?.constructor !== MfaEnrolments)) {
      for (const name of await source.stepsOf(id)) out.add(name);
    }
    return [...out];
  }

  private async forced(id: IdentityRef, facts: Pick<AuthnFacts, 'method' | 'strategy'>): Promise<boolean> {
    if (this.force) return true;
    if (this.forceForRoles.length === 0) return false;
    try {
      const principals = await this.container.resolve(PrincipalFactory);
      const principal = await principals.principalOf(id, { ...facts, assurance: 'aal1', mfa: [], authenticatedAt: new Date() }, {});
      const roles = await (await this.container.resolve(RoleSource)).rolesOf(principal);
      return roles.some((r) => this.forceForRoles.includes(r.role));
    } catch {
      // Fail closed: without the roles, ask for the step.
      return true;
    }
  }
}
