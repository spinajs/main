import { Autoinject, Container, Injectable, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { AutoinjectNamedServices, Config } from '@spinajs/configuration';
import { InvalidOperation, InvalidOption } from '@spinajs/exceptions';

import type { IdentityRef } from '../contracts/credentials.js';
import { RoleSource } from '../contracts/hooks.js';
import { MfaPolicy, MfaStep } from '../contracts/mfa.js';
import type { AuthnFacts } from '../contracts/principal.js';
import { PrincipalFactory } from '../contracts/service.js';
import { MfaEnrolmentMismatch, MfaEnrolments, MfaStepNotListed } from './mfa-enrolments.js';

/** completeMfa's step name for recovery codes; no configured step may take it. */
export const RECOVERY_STEP = 'recovery';

/**
 * An MfaPolicy whose steps are those of `authn.mfa.steps`, keyed by name in list order and looked up by service name
 * across the container lineage (nearest first). Listed as the policy resolves, so a bad list fails the boot, and kept
 * for the life of the instance: a later Configuration.set changes nothing until the policy is resolved anew. Fails on
 * an unknown service (ServiceNotFound), an entry name that differs from the step's own `name` and a service that is
 * not an MfaStep (InvalidOption). Extend it to give a custom policy the configured steps.
 */
export abstract class ConfiguredMfaPolicy extends MfaPolicy {
  // Undefined for an instance a factory returns: only DI injects it.
  @AutoinjectNamedServices('authn.mfa.steps', MfaStep, { lineage: true, keyBy: 'name' })
  protected Steps: Map<string, MfaStep> | undefined;

  public async resolve(): Promise<void> {
    // Duck-typed: steps built against another copy of the contracts (cjs/mjs, the kit) fail instanceof.
    for (const [name, step] of this.Steps ?? []) {
      if (typeof step.verify !== 'function' || typeof step.enrolled !== 'function') {
        throw new InvalidOption(`authn.mfa.steps entry ${JSON.stringify(name)}: the service is not an MfaStep`);
      }
    }
    await super.resolve();
  }

  public async steps(): Promise<ReadonlyMap<string, MfaStep>> {
    if (!this.Steps) throw new InvalidOperation(`${this.constructor.name} was not created by DI and has no container to list authn.mfa.steps from`);
    return this.Steps;
  }
}

/**
 * Design §22.3: the steps of `authn.mfa.steps` the identity is enrolled in, for logins whose method `authn.mfa.policy.methods`
 * lists. The default is password only (D13): a key challenge proves possession and an IdP does its own MFA, so list
 * `oidc` to ask for a step after an IdP login too. When none is enrolled, every MfaEnrolments source of the
 * container lineage is asked, and any step a source reports refuses the login, forced or not, as the identity never
 * logs in with the password alone (§22.4, §22.18): MfaStepNotListed for a step the list leaves out, else
 * MfaEnrolmentMismatch (a listed step that does not see the stored enrolment). Otherwise `force`, or a role of
 * `forceForRoles` (asked through RoleSource), requires the first configured step, so the pending session can only
 * enrol. Boot fails when forceForRoles has no RoleSource or PrincipalFactory to ask; the schema refuses force and
 * forceForRoles with no step to require.
 */
@PerChildInstance()
@Injectable(MfaPolicy)
export class DefaultMfaPolicy extends ConfiguredMfaPolicy {
  @Autoinject(Container)
  protected Container: IContainer;

  @Config('authn.mfa.policy.force')
  protected Force: boolean;

  @Config('authn.mfa.policy.forceForRoles')
  protected ForceForRoles: string[];

  @Autoinject(PrincipalFactory, { optional: true })
  protected Principals: PrincipalFactory | undefined;

  @Autoinject(RoleSource, { optional: true })
  protected Roles: RoleSource | undefined;

  @Config('authn.mfa.policy.methods')
  protected Methods: string[];

  public get force(): boolean {
    return this.Force === true;
  }

  public get methods(): readonly string[] {
    return this.Methods ?? ['password'];
  }

  public get forceForRoles(): readonly string[] {
    return this.ForceForRoles ?? [];
  }

  public async resolve(): Promise<void> {
    if (this.forceForRoles.length > 0) {
      const required: ReadonlyArray<readonly [unknown, string]> = [
        [this.Roles, 'RoleSource'],
        [this.Principals, 'PrincipalFactory'],
      ];
      for (const [dependency, name] of required) {
        if (!dependency) throw new InvalidOption(`authn.mfa.policy.forceForRoles needs a ${name} to read roles, and none is registered`);
      }
    }
    await super.resolve();
  }

  public async required(id: IdentityRef, facts: Pick<AuthnFacts, 'method' | 'strategy'>): Promise<readonly string[]> {
    if (!this.methods.includes(facts.method)) return [];
    const steps = [...(await this.steps()).values()];
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
    const sources = await this.Container.resolve(Array.chainOf(MfaEnrolments));
    const out = new Set<string>();
    for (const source of sources) {
      for (const name of await source.stepsOf(id)) out.add(name);
    }
    return [...out];
  }

  private async forced(id: IdentityRef, facts: Pick<AuthnFacts, 'method' | 'strategy'>): Promise<boolean> {
    if (this.force) return true;
    if (this.forceForRoles.length === 0) return false;
    try {
      const principal = await this.Principals!.principalOf(id, { ...facts, assurance: 'aal1', mfa: [], authenticatedAt: new Date() }, {});
      const roles = await this.Roles!.rolesOf(principal);
      return roles.some((r) => this.forceForRoles.includes(r.role));
    } catch {
      // Fail closed: without the roles, ask for the step.
      return true;
    }
  }
}
