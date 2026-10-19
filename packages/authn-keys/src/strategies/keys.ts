import { Autoinject } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import '@spinajs/authn/register-schema';
import { AuthenticationStrategy, KeyRegistry } from '@spinajs/authn/contracts';
import type { AuthnContext, AuthnFailure, KeyAlgorithm, IdentityRef, KeyOwner, KeyRecord, StrategyOutcome, ThrottleKey } from '@spinajs/authn/contracts';
import { isValidKid } from '../jwk/keys.js';
import { dummyVerify } from '../jwk/signature.js';
import { keysOptionsOf } from '../options/options.js';
import type { KeysConfig, KeysOptions } from '../options/options.js';
import { isUsableKey } from '../registry/registry.js';

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

export const failure = (reason: AuthnFailure): StrategyOutcome => ({ ok: false, reason });

/** A test seam for building a key strategy with `new`: each field replaces what DI injects. */
export interface KeyStrategyDeps {
  readonly registry?: KeyRegistry;
  /** Complete options that bypass the configuration. */
  readonly options?: KeysOptions;
}

/** What the key strategies share: the registry, `authn.keys`, the cost of an unusable key and the success outcome. */
export abstract class KeyStrategy<D extends KeyStrategyDeps = KeyStrategyDeps> extends AuthenticationStrategy {
  @Config('authn.keys')
  protected KeysConfig: KeysConfig;

  @Autoinject(KeyRegistry)
  protected Registry: KeyRegistry;

  @Logger('authn-keys')
  protected Log: Log;

  constructor(protected readonly Deps?: D) {
    super();
  }

  protected get registry(): KeyRegistry {
    return this.Deps?.registry ?? this.Registry;
  }

  protected get options(): KeysOptions {
    return keysOptionsOf(this.Deps?.options ?? this.KeysConfig);
  }

  /** The signature work an unknown, revoked or expired key costs, so it answers in the time a known key does (A02). */
  protected unknownKeyWork(alg: KeyAlgorithm, data: Uint8Array, signature: Uint8Array): void {
    dummyVerify(alg, data, signature);
  }

  /** Stamps the key's last use when the registry can; a failed stamp costs the stamp, never the login. */
  protected async success(key: KeyRecord, method: string, ctx: AuthnContext): Promise<StrategyOutcome> {
    const registry = this.registry;
    if (registry.touch) {
      try {
        await registry.touch(key.kid, ctx.now);
      } catch (err) {
        this.Log.error({ error: err, kid: key.kid }, 'Could not stamp the last use of key ${kid}');
      }
    }
    return { ok: true, identity: { type: key.owner.type, id: key.owner.id }, method, ...(key.scope ? { ceiling: key.scope } : {}) };
  }
}
