import type { ExternalSubject } from '../contracts/credentials.js';
import type { AuthenticationStrategy } from '../contracts/strategy.js';

/** One provider's own linking switches: JIT provisioning, and linking an unlinked subject by its verified email. */
export interface ExternalLinkingSwitches {
  readonly jit: boolean;
  readonly byVerifiedEmail: boolean;
}

/**
 * A strategy that answers external subjects and holds per-provider linking switches (OIDC `providers.<name>.linking`,
 * JWT `issuers[i].linking`). DefaultAuthnService provisions or links by verified email only when both the global
 * `authn.linking` switch and the switch this returns for the subject's provider are on (K6), so turning JIT on for one
 * provider never opens another. A strategy without `linkingFor` gets neither.
 */
export interface ExternalLinkingStrategy {
  linkingFor(external: ExternalSubject): ExternalLinkingSwitches;
}

const OFF: ExternalLinkingSwitches = Object.freeze({ jit: false, byVerifiedEmail: false });

/** The strategy's switches for `external`; off when it has none, answers anything but booleans, or throws. */
export function linkingSwitchesOf(s: AuthenticationStrategy, external: ExternalSubject): ExternalLinkingSwitches {
  const linkingFor = (s as Partial<ExternalLinkingStrategy>).linkingFor;
  if (typeof linkingFor !== 'function') return OFF;
  try {
    const sw: unknown = linkingFor.call(s, external);
    if (sw === null || typeof sw !== 'object') return OFF;
    const { jit, byVerifiedEmail } = sw as Record<string, unknown>;
    return { jit: jit === true, byVerifiedEmail: byVerifiedEmail === true };
  } catch {
    return OFF;
  }
}
