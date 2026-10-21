import { randomUUID } from 'node:crypto';
import { Autoinject, Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { AuthenticationStrategy, IdentityStore, PasswordCredentialStore } from '@spinajs/authn/contracts';
import { isValidField, loginField } from '@spinajs/authn/schemas';
import type { AuthnContext, Credentials, IdentityRef, StrategyOutcome, ThrottleKey } from '@spinajs/authn/contracts';

import { PasswordHasher } from './hasher.js';
import { HasherBusy } from './limiter.js';
import { isLoginLength, LocalPasswordPolicy } from './policy.js';

const INVALID: StrategyOutcome = { ok: false, reason: 'invalid_credentials' };
const UNSUPPORTED: StrategyOutcome = { ok: false, reason: 'unsupported_credentials' };
const BUSY: StrategyOutcome = { ok: false, reason: 'throttled', retryAfterSeconds: 1 };

const isPasswordKind = (c: Credentials) => c !== null && typeof c === 'object' && c.kind === 'password';

/** The part of `Log` the strategy uses. */
export type LocalPasswordStrategyLog = Pick<Log, 'warn'>;

export interface LocalPasswordStrategyDeps {
  readonly identities: IdentityStore;
  readonly passwords: PasswordCredentialStore;
  readonly hasher: PasswordHasher;
  readonly log?: LocalPasswordStrategyLog;
}

/** The throttle's account key for a login (D7); never the raw login as typed. */
export function normalizeLogin(login: string): string {
  return login.normalize('NFKC').trim().toLowerCase();
}

function passwordFields(c: Credentials): { login: string; password: string } | null {
  if (c === null || typeof c !== 'object' || c.kind !== 'password') {
    return null;
  }
  const { login, password } = c as { login: unknown; password: unknown };
  return typeof login === 'string' && typeof password === 'string' ? { login, password } : null;
}

/**
 * Login and password (A02, A03). Verify only: the caller checks status, counts the throttle, audits and opens sessions. Every
 * path spends exactly one argon2 verify, so unknown and known accounts take the same time; a successful login whose hash
 * needs a rehash spends one more hash.
 */
@Injectable(AuthenticationStrategy)
export class LocalPasswordStrategy extends AuthenticationStrategy {
  public readonly name = 'local';
  public readonly kinds: readonly string[] = ['password'];
  public readonly interactive = true;

  @Logger('authn-local')
  protected Log: Log;

  @Autoinject(PasswordHasher)
  protected Hasher: PasswordHasher;

  // Boot resolves the strategies (authn.strategies) but not PasswordService; injecting the policy here makes a bad
  // authn.local.policy fail at boot instead of on the first password change.
  @Autoinject(LocalPasswordPolicy)
  protected Policy: LocalPasswordPolicy;

  @Autoinject(IdentityStore)
  protected Identities: IdentityStore;

  @Autoinject(PasswordCredentialStore)
  protected Passwords: PasswordCredentialStore;

  private _hasher?: PasswordHasher;

  /** With `deps` nothing is taken from the container, so a test can build one without it. */
  constructor(protected readonly Deps?: LocalPasswordStrategyDeps) {
    super();
  }

  /** The injected hasher made its dummy hash at boot (D4). */
  public async resolve(): Promise<void> {
    if (this.Deps) {
      // A hasher handed in by a test is not resolved by DI.
      this._hasher = this.Deps.hasher;
      await this._hasher.resolve();
    } else {
      this._hasher = this.Hasher;
    }
    await super.resolve();
  }

  /** The account key only: the core builds the `account-ip` key itself and drops one a strategy sends. */
  public throttleKeys(c: Credentials, _ctx: AuthnContext): readonly ThrottleKey[] {
    const login = c !== null && typeof c === 'object' && c.kind === 'password' ? (c as { login: unknown }).login : undefined;
    if (typeof login !== 'string') {
      return [];
    }
    return [{ kind: 'account', value: normalizeLogin(login) }];
  }

  public async verify(c: Credentials, ctx: AuthnContext): Promise<StrategyOutcome> {
    try {
      return await this.check(c, ctx);
    } catch (err) {
      if (err instanceof HasherBusy) {
        return BUSY;
      }
      throw err;
    }
  }

  protected async check(c: Credentials, _ctx: AuthnContext): Promise<StrategyOutcome> {
    const hasher = await this.hasher();
    const fields = passwordFields(c);

    // An empty password keeps the dummy verify cheap for an over-long input; the work is the same argon2 verify.
    if (!fields || !isLoginLength(fields.password) || !isValidField(loginField, fields.login)) {
      await hasher.verify(null, '');
      return isPasswordKind(c) ? INVALID : UNSUPPORTED;
    }

    const id = await (await this.identities()).findByLogin(fields.login);
    // An unknown login still reads the store, for a fresh ref no cache can know, so its work matches a known one (A02).
    const stored = await (await this.passwords()).get(id ?? { type: 'user', id: randomUUID() });
    if (!(await hasher.verify(stored, fields.password)) || !id || stored === null) {
      return INVALID;
    }

    if (hasher.needsRehash(stored)) {
      await this.rehash(hasher, id, fields.password, stored);
    }

    return { ok: true, identity: id, method: 'password' };
  }

  protected async rehash(hasher: PasswordHasher, id: IdentityRef, password: string, verified: string): Promise<void> {
    try {
      const fresh = await hasher.hash(password);
      // Only over the verified hash: a reset, set, change or expiry that stored a new value meanwhile must not get the old
      // password written back over it (A30). A lost race leaves the newer value and needs no retry.
      await (await this.passwords()).set(id, fresh, verified);
    } catch (err) {
      // The name only: some ORM errors carry the query bindings, i.e. the new hash, in their message.
      this.log().warn({ identityType: id.type, identityId: id.id, errorName: (err as Error)?.name ?? typeof err }, 'Could not store the rehashed password of ${identityType} ${identityId}: ${errorName}');
    }
  }

  protected async hasher(): Promise<PasswordHasher> {
    if (!this._hasher) throw new InvalidOperation('LocalPasswordStrategy is not resolved');
    return this._hasher;
  }

  protected async identities(): Promise<IdentityStore> {
    return this.Deps?.identities ?? this.Identities;
  }

  protected async passwords(): Promise<PasswordCredentialStore> {
    return this.Deps?.passwords ?? this.Passwords;
  }

  protected log(): LocalPasswordStrategyLog {
    return this.Deps ? (this.Deps.log ?? { warn: () => undefined }) : this.Log;
  }
}
