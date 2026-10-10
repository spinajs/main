import { InvalidOperation } from '@spinajs/exceptions';

import type { IdentityRef } from '../contracts/credentials.js';

/**
 * Confirmed MFA enrolments as a store holds them, whether `authn.mfa.steps` lists the step or not (design §22.4,
 * §22.18). DefaultMfaPolicy refuses a password login of an identity whose listed steps see no enrolment while a source
 * reports one, so a 2.x migration that carried TOTP secrets but listed no step cannot let those users in with the
 * password alone; authn:check-config reports the steps the list leaves out. Every registration in the container
 * lineage is asked; authn-orm registers one over `authn_mfa`. Side-effect free, also as
 * `@spinajs/authn/mfa-enrolments`.
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

/**
 * DefaultMfaPolicy: a source reports the identity confirmed in listed `steps`, yet each of those steps says it is not
 * enrolled, e.g. the step reads another secret store than the one the 2.x migration filled.
 */
export class MfaEnrolmentMismatch extends InvalidOperation {
  constructor(public readonly steps: readonly string[]) {
    super(`a store holds a confirmed enrolment in MFA step(s) ${steps.map((s) => JSON.stringify(s)).join(', ')}, which the step does not see`);
    this.name = 'MfaEnrolmentMismatch';
  }
}

// By name, so an error of another copy of this module (cjs and mjs) counts too.
const named = (e: unknown, name: string): e is { steps: readonly string[] } => e instanceof Error && e.name === name && Array.isArray((e as Partial<MfaStepNotListed>).steps);

export function isMfaStepNotListed(e: unknown): e is MfaStepNotListed {
  return named(e, 'MfaStepNotListed');
}

export function isMfaEnrolmentMismatch(e: unknown): e is MfaEnrolmentMismatch {
  return named(e, 'MfaEnrolmentMismatch');
}

/** The audit reason and steps when `e` is DefaultMfaPolicy refusing a login over the stored enrolments, else undefined. */
export function mfaEnrolmentRefusal(e: unknown): { reason: 'mfa_step_not_listed' | 'mfa_enrolment_mismatch'; steps: readonly string[] } | undefined {
  if (isMfaStepNotListed(e)) return { reason: 'mfa_step_not_listed', steps: e.steps };
  if (isMfaEnrolmentMismatch(e)) return { reason: 'mfa_enrolment_mismatch', steps: e.steps };
  return undefined;
}
