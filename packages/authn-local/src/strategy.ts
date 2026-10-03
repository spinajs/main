import { randomUUID } from 'node:crypto';
import { DI, Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { AuthenticationStrategy, IdentityStore, PasswordCredentialStore } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, IdentityRef, StrategyOutcome, ThrottleKey } from '@spinajs/authn/contracts';

import { PasswordHasher } from './hasher.js';
import { isLoginLength } from './policy.js';

const INVALID: StrategyOutcome = { ok: false, reason: 'invalid_credentials' };

/** The part of `Log` the strategy uses. */
export interface LocalPasswordStrategyLog {
  warn(message: string, ...args: unknown[]): void;
}

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

  private _hasher?: PasswordHasher;

  /** With `deps` nothing is taken from the container, so a test can build one without it. */
  constructor(protected readonly Deps?: LocalPasswordStrategyDeps) {
    super();
  }

  /** Resolves the hasher, which makes its dummy hash, at boot (D4). */
  public async resolve(): Promise<void> {
    this._hasher = this.Deps ? this.Deps.hasher : await DI.resolve(PasswordHasher);
    await this._hasher.resolve();
    await super.resolve();
  }

  public throttleKeys(c: Credentials, ctx: AuthnContext): readonly ThrottleKey[] {
    const login = c !== null && typeof c === 'object' && c.kind === 'password' ? (c as { login: unknown }).login : undefined;
    if (typeof login !== 'string') {
      return [];
    }
    const account = normalizeLogin(login);
    return [
      { kind: 'account', value: account },
      { kind: 'account-ip', value: `${account}|${ctx.ip ?? ''}` },
    ];
  }

  public async verify(c: Credentials, _ctx: AuthnContext): Promise<StrategyOutcome> {
    const hasher = await this.hasher();
    const fields = passwordFields(c);

    // An empty password keeps the dummy verify cheap for an over-long input; the work is the same argon2 verify.
    if (!fields || !isLoginLength(fields.password)) {
      await hasher.verify(null, '');
      return INVALID;
    }

    const id = await this.identities().findByLogin(fields.login);
    // An unknown login still reads the store, for a fresh ref no cache can know, so its work matches a known one (A02).
    const stored = await this.passwords().get(id ?? { type: 'user', id: randomUUID() });
    if (!(await hasher.verify(stored, fields.password)) || !id || stored === null) {
      return INVALID;
    }

    if (hasher.needsRehash(stored)) {
      await this.rehash(hasher, id, fields.password);
    }

    return { ok: true, identity: id, method: 'password' };
  }

  protected async rehash(hasher: PasswordHasher, id: IdentityRef, password: string): Promise<void> {
    try {
      await this.passwords().set(id, await hasher.hash(password));
    } catch (err) {
      // The name only: some ORM errors carry the query bindings, i.e. the new hash, in their message.
      this.log().warn(`Could not store the rehashed password of ${id.type} ${id.id}: ${(err as Error)?.name ?? typeof err}`);
    }
  }

  protected async hasher(): Promise<PasswordHasher> {
    if (!this._hasher) {
      await this.resolve();
    }
    return this._hasher!;
  }

  protected identities(): IdentityStore {
    return this.Deps ? this.Deps.identities : DI.resolve(IdentityStore);
  }

  protected passwords(): PasswordCredentialStore {
    return this.Deps ? this.Deps.passwords : DI.resolve(PasswordCredentialStore);
  }

  protected log(): LocalPasswordStrategyLog {
    return this.Deps ? (this.Deps.log ?? { warn: () => undefined }) : this.Log;
  }
}
