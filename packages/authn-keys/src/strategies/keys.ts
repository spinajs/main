import type { AuthnContext, AuthnFailure, KeyAlgorithm, IdentityRef, KeyOwner, KeyRecord, KeyRegistry, StrategyOutcome, ThrottleKey } from '@spinajs/authn/contracts';
import { isValidKid } from '../jwk/keys.js';
import { DefaultKeyRegistry, isUsableKey } from '../registry/registry.js';

/** Credentials longer than this are refused before any parsing (a header is parsed before its signature is checked). */
export const MAX_CREDENTIAL_LENGTH = 8192;

/** An assertion's `iss`: the key owner as `<type>:<id>` (lane notes D8), e.g. `user:<uuid>` or `service:runner-1`. */
export const assertionIssuer = (owner: KeyOwner | IdentityRef): string => `${owner.type}:${owner.id}`;

/** Credentials name a kid before anything is verified; one that cannot be read throttles under one shared key. */
export function keyThrottleKeys(kid: string | null, ctx: AuthnContext): readonly ThrottleKey[] {
  const id = kid !== null && isValidKid(kid) ? `key:${kid}` : 'key:?';
  return [
    { kind: 'account', value: id },
    { kind: 'account-ip', value: `${id}|${ctx.ip ?? ''}` },
  ];
}

/** `alg`: the algorithm of a revoked or expired key, so the dummy verification costs what its real one would. */
export type KeyLookup = { readonly key: KeyRecord } | { readonly key: null; readonly reason: AuthnFailure; readonly alg?: KeyAlgorithm };

/** byId for verifiers: only a key that is neither revoked nor expired at ctx.now is usable; the reason goes to audit. */
export async function usableKey(registry: KeyRegistry, kid: string, ctx: AuthnContext): Promise<KeyLookup> {
  const key = isValidKid(kid) ? await registry.byId(kid) : null;
  if (!key) {
    return { key: null, reason: 'invalid_credentials' };
  }
  if (!isUsableKey(key, ctx.now)) {
    return { key: null, reason: key.revokedAt ? 'revoked' : 'expired', alg: key.alg };
  }
  return { key };
}

export async function keySuccess(registry: KeyRegistry, key: KeyRecord, method: string, ctx: AuthnContext): Promise<StrategyOutcome> {
  if (registry instanceof DefaultKeyRegistry) {
    await registry.touch(key.kid, ctx.now);
  }
  return { ok: true, identity: { type: key.owner.type, id: key.owner.id }, method, ...(key.scope ? { ceiling: key.scope } : {}) };
}

export const failure = (reason: AuthnFailure): StrategyOutcome => ({ ok: false, reason });
