import type { OidcClaimPath, OidcClaimsMapping, OidcExternalSubject, OidcStrategyName } from './contracts.js';
import { isPlainObject } from './support.js';

/** authn_identity column widths. */
export const MAX_SUBJECT_LENGTH = 255;
export const MAX_EMAIL_LENGTH = 255;
const MAX_NAME_LENGTH = 255;

/** A top-level claim (dots belong to the name) or a path through nested objects; own properties only. */
export function readClaim(claims: Readonly<Record<string, unknown>>, path: OidcClaimPath): unknown {
  const segments = typeof path === 'string' ? [path] : path;
  let at: unknown = claims;
  for (const segment of segments) {
    if (!isPlainObject(at) || !Object.hasOwn(at, segment)) return undefined;
    at = at[segment];
  }
  return at;
}

/** The validated ID token's claims, then the userinfo claims it lacks; never a token. */
export function rawClaims(idToken: Readonly<Record<string, unknown>> | null, userinfo: Readonly<Record<string, unknown>> | null): Readonly<Record<string, unknown>> {
  // Spread defines own data properties, so a '__proto__' member of either stays a plain member.
  return Object.freeze({ ...(userinfo ?? {}), ...(idToken ?? {}) });
}

function subjectOf(v: unknown): string | null {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === 'string' && v.length > 0 && v.length <= MAX_SUBJECT_LENGTH) return v;
  return null;
}

function groupsOf(v: unknown): readonly string[] | undefined {
  if (typeof v === 'string') return Object.freeze([v]);
  if (Array.isArray(v)) return Object.freeze(v.filter((g): g is string => typeof g === 'string'));
  return undefined;
}

/** Maps the raw claims to the subject every ExternalLoginHook receives (OidcClaimsMapping docs); throws without a subject. */
export function mapClaims(provider: OidcStrategyName, mapping: OidcClaimsMapping, raw: Readonly<Record<string, unknown>>): OidcExternalSubject {
  const subject = subjectOf(readClaim(raw, mapping.subject));
  if (subject === null) {
    throw new Error('authn-oidc: the login carries no usable subject');
  }
  const email = mapping.email === null ? undefined : readClaim(raw, mapping.email);
  const hasEmail = typeof email === 'string' && email.length > 0 && email.length <= MAX_EMAIL_LENGTH;
  const name = mapping.name === null ? undefined : readClaim(raw, mapping.name);
  const groups = mapping.groups === null ? undefined : groupsOf(readClaim(raw, mapping.groups));
  return Object.freeze({
    provider,
    subject,
    ...(hasEmail ? { email, emailVerified: mapping.emailVerified !== null && readClaim(raw, mapping.emailVerified) === true } : {}),
    claims: Object.freeze({
      ...(typeof name === 'string' && name.length <= MAX_NAME_LENGTH ? { name } : {}),
      ...(groups !== undefined ? { groups } : {}),
      raw,
    }),
  });
}

/** requiredClaims: each top-level claim present with exactly that value. */
export function hasRequiredClaims(raw: Readonly<Record<string, unknown>>, required: Readonly<Record<string, string | number | boolean>>): boolean {
  return Object.entries(required).every(([k, v]) => Object.hasOwn(raw, k) && raw[k] === v);
}
