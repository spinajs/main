import { Autoinject, Injectable } from '@spinajs/di';
import { AuthenticationStrategy, IdentityStore, SecretStore } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, StrategyOutcome, ThrottleKey } from '@spinajs/authn/contracts';

/** Left out, a dependency comes from DI. */
export interface EmailCodeStrategyDeps {
  readonly identities: IdentityStore;
  readonly secrets: SecretStore;
}

/** Login with a code mailed to the account's address (A36). */
@Injectable(AuthenticationStrategy)
export class EmailCodeStrategy extends AuthenticationStrategy {
  public readonly name = 'email-code';
  public readonly kinds: readonly string[] = ['email-code'];
  public readonly interactive = true;

  @Autoinject(IdentityStore)
  protected Identities: IdentityStore;

  @Autoinject(SecretStore)
  protected Secrets: SecretStore;

  constructor(protected readonly Deps?: EmailCodeStrategyDeps) {
    super();
  }

  public throttleKeys(_c: Credentials, _ctx: AuthnContext): readonly ThrottleKey[] {
    throw new Error('not implemented: EmailCodeStrategy.throttleKeys');
  }

  public async verify(_c: Credentials, _ctx: AuthnContext): Promise<StrategyOutcome> {
    throw new Error('not implemented: EmailCodeStrategy.verify');
  }
}
