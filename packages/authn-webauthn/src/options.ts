import { InvalidOption } from '@spinajs/exceptions';

/** `authn.webauthn`, as the schema validates and defaults it. */
export interface WebAuthnOptions {
  readonly rpId: string;
  readonly rpName: string;
  readonly origins: readonly string[];
  readonly userVerification: 'required' | 'preferred' | 'discouraged';
  readonly challengeTtlSeconds: number;
  readonly recoveryCodes: number;
}

const inRange = (value: unknown, min: number, max: number): boolean => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
const text = (value: unknown): boolean => typeof value === 'string' && value !== '';

// The schema is the gate; this floor holds for values that never went through it (deps.options, a runtime Configuration.set).
export function assertWebAuthnOptions(o: WebAuthnOptions | undefined): WebAuthnOptions {
  const ok =
    !!o &&
    text(o.rpId) &&
    text(o.rpName) &&
    Array.isArray(o.origins) &&
    o.origins.every(text) &&
    ['required', 'preferred', 'discouraged'].includes(o.userVerification) &&
    inRange(o.challengeTtlSeconds, 1, 3600) &&
    inRange(o.recoveryCodes, 0, 100);
  if (!ok) throw new InvalidOption('authn.webauthn: rpId, rpName, origins, userVerification, challengeTtlSeconds or recoveryCodes is missing or out of range');
  return o;
}
