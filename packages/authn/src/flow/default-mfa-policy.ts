import { Container, Inject, Injectable, PerChildInstance } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';

import type { IdentityRef } from '../contracts/credentials.js';
import { RoleSource } from '../contracts/hooks.js';
import { MfaPolicy } from '../contracts/mfa.js';
import type { AuthnFacts } from '../contracts/principal.js';
import { PrincipalFactory } from '../contracts/service.js';
import { nonEmpty, readNamedEntries } from '../registry/named.js';
import { MfaStepRegistry } from './mfa-step-registry.js';

function readForce(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== 'boolean') throw new InvalidOption('authn.mfa.policy.force must be a boolean');
  return raw;
}

function readRoles(raw: unknown): readonly string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || !raw.every(nonEmpty)) throw new InvalidOption('authn.mfa.policy.forceForRoles must be a list of role names');
  return Object.freeze([...new Set(raw)]);
}

/**
 * Design §22.3: the steps of `authn.mfa.steps` the identity is enrolled in, for password logins only (D13: a key
 * challenge proves possession and an IdP does its own MFA). When none is enrolled, `force`, or a role of
 * `forceForRoles` (asked through RoleSource), requires the first configured step, so the pending session can only
 * enrol. Boot fails when force has no step to require, or forceForRoles has no RoleSource to ask.
 */
@PerChildInstance()
@Injectable(MfaPolicy)
@Inject(Container, Configuration)
export class DefaultMfaPolicy extends MfaPolicy {
  public readonly force: boolean;
  public readonly forceForRoles: readonly string[];

  constructor(private readonly container: IContainer, configuration: Configuration) {
    super();
    this.force = readForce(configuration.get('authn.mfa.policy.force'));
    this.forceForRoles = readRoles(configuration.get('authn.mfa.policy.forceForRoles'));
    if (!this.force && this.forceForRoles.length === 0) return;
    const option = this.force ? 'authn.mfa.policy.force' : 'authn.mfa.policy.forceForRoles';
    if (readNamedEntries(configuration.get('authn.mfa.steps'), 'authn.mfa.steps', 'step').length === 0) {
      throw new InvalidOption(`${option} needs a step to require, but authn.mfa.steps is empty`);
    }
    if (this.forceForRoles.length > 0) {
      for (const [type, name] of [
        [RoleSource, 'RoleSource'],
        [PrincipalFactory, 'PrincipalFactory'],
      ] as const) {
        if (!container.hasRegistered(type as unknown as Class<unknown>)) throw new InvalidOption(`authn.mfa.policy.forceForRoles needs a ${name} to read roles, and none is registered`);
      }
    }
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
