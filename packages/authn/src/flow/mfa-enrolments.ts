import { InvalidOperation } from '@spinajs/exceptions';

import type { IdentityRef } from '../contracts/credentials.js';

/**
 * Confirmed MFA enrolments as a store holds them, whether `authn.mfa.steps` lists the step or not (design §22.4,
 * §22.18). DefaultMfaPolicy refuses a password login of an identity enrolled in a step the list leaves out, so a 2.x
 * migration that carried TOTP secrets but listed no step cannot let those users in with the password alone;
 * authn:check-config reports such steps. Every registration in the container lineage is asked; authn-orm registers
 * one over `authn_mfa`. Side-effect free, also as `@spinajs/authn/mfa-enrolments`.
 */
export abstract class MfaEnrolments {
  /** The names of the steps the identity has confirmed. */
  abstract stepsOf(id: IdentityRef): Promise<readonly string[]>;

  /** Each step name with a confirmed enrolment of any identity, once. */
  abstract stepNames(): Promise<readonly string[]>;
}

/** DefaultMfaPolicy: the identity is enrolled in `steps`, which `authn.mfa.steps` does not list. */
export class MfaStepNotListed extends InvalidOperation {
  constructor(public readonly steps: readonly string[]) {
    super(`the identity is enrolled in MFA step(s) ${steps.map((s) => JSON.stringify(s)).join(', ')}, which authn.mfa.steps does not list`);
    this.name = 'MfaStepNotListed';
  }
}

/** By name, so an error of another copy of this module (cjs and mjs) counts too. */
export function isMfaStepNotListed(e: unknown): e is MfaStepNotListed {
  return e instanceof Error && e.name === 'MfaStepNotListed' && Array.isArray((e as Partial<MfaStepNotListed>).steps);
}
