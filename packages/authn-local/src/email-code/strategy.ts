import { randomUUID } from 'node:crypto';
import { Autoinject, Injectable } from '@spinajs/di';
import { AuthenticationStrategy, IdentityStore, SecretStore } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, IdentityRef, StrategyOutcome, ThrottleKey } from '@spinajs/authn/contracts';

import { EmailCodes } from './codes.js';
import { normalizeLogin } from '../strategy.js';

const INVALID: StrategyOutcome = { ok: false, reason: 'invalid_credentials' };
const UNSUPPORTED: StrategyOutcome = { ok: false, reason: 'unsupported_credentials' };

/** Left out, a dependency comes from DI. */
export interface EmailCodeStrategyDeps {
  readonly identities: IdentityStore;
  readonly secrets: SecretStore;
}

function codeFields(c: Credentials): { login: string; code: string } | null {
  const { login, code } = c as { login?: unknown; code?: unknown };
  return typeof login === 'string' && typeof code === 'string' ? { login, code } : null;
}

/**
 * Login with a code mailed to the account's address (A36). Verify only: the caller checks status, counts the throttle, audits
 * and opens sessions. The code is asked for with `PasswordService.requestCode`. Every path spends the same redeems, so an
 * unknown login takes the time of a known one. A code login is a single factor like a password: assurance `aal1`.
 */
@Injectable(AuthenticationStrategy)
export class EmailCodeStrategy extends AuthenticationStrategy {
  public readonly name = 'email-code';
  public readonly kinds: readonly string[] = ['email-code'];
  public readonly interactive = true;

  @Autoinject(IdentityStore)
  protected Identities: IdentityStore;

  @Autoinject(SecretStore)
  protected Secrets: SecretStore;

  private _codes?: EmailCodes;

  constructor(protected readonly Deps?: EmailCodeStrategyDeps) {
    super();
  }

  /** Its own account key, so wrong codes and a successful code login neither use up nor clear the password backoff. */
  public throttleKeys(c: Credentials, _ctx: AuthnContext): readonly ThrottleKey[] {
    const fields = c !== null && typeof c === 'object' && c.kind === 'email-code' ? codeFields(c) : null;
    return fields ? [{ kind: 'account', value: `code:${normalizeLogin(fields.login)}` }] : [];
  }

  public async verify(c: Credentials, _ctx: AuthnContext): Promise<StrategyOutcome> {
    if (c === null || typeof c !== 'object' || c.kind !== 'email-code') {
      return UNSUPPORTED;
    }
    const fields = codeFields(c);
    const id = fields ? await this.identities().findByLogin(fields.login) : null;
    const known: IdentityRef = id ?? { type: 'user', id: randomUUID() };
    const matched = await this.codes().verify(known, fields?.code ?? '');
    return fields && id && matched ? { ok: true, identity: id, method: 'email-code', assurance: 'aal1' } : INVALID;
  }

  private codes(): EmailCodes {
    return (this._codes ??= new EmailCodes(this.Deps ? this.Deps.secrets : this.Secrets));
  }

  private identities(): IdentityStore {
    return this.Deps ? this.Deps.identities : this.Identities;
  }
}
