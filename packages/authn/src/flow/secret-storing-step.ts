import type { MfaStep } from '../contracts/mfa.js';

/**
 * An MFA step that stores secrets (D3), such as TOTP seeds. When one is configured, `authn.mfa.encryptionKey.secret`
 * must be set outside development and test (A24).
 */
export interface SecretStoringMfaStep extends MfaStep {
  readonly storesSecrets: true;
}

// Duck-typed like MfaStepRegistry: steps built against another copy of the contracts fail instanceof.
export function isSecretStoringMfaStep(step: unknown): step is SecretStoringMfaStep {
  if (step === null || typeof step !== 'object') return false;
  const s = step as Partial<SecretStoringMfaStep>;
  return typeof s.verify === 'function' && typeof s.enrolled === 'function' && s.storesSecrets === true;
}
