import { Autoinject } from '@spinajs/di';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Orm } from '@spinajs/orm';
import { Log, Logger } from '@spinajs/log';
import { IdentityStore } from '@spinajs/authn/contracts';
import { TotpService } from '../service/totp-service.js';
import { CLI_ACTOR, cliContext } from './common.js';

/** Replaces `rbac:user-enable-2fa`, which handed a TOTP secret to the operator (SR-10). */
@Command('authn:mfa-reset', 'Removes the MFA enrolment and recovery codes of an account; prints no secret')
@Argument('login', true, 'login or email')
export class MfaReset extends CliCommand {
  // Boots the ORM before the command runs; the identity store needs it.
  @Autoinject(Orm)
  protected Orm: Orm;

  @Logger('authn-totp')
  protected Log: Log;

  @Autoinject(IdentityStore)
  protected Identities: IdentityStore;

  @Autoinject(TotpService)
  protected Totp: TotpService;

  public async execute(login: string): Promise<void> {
    if (typeof this.Identities?.findByLogin !== 'function') {
      throw new Error('authn:mfa-reset needs a registered IdentityStore');
    }
    const id = await this.Identities.findByLogin(login);
    if (!id) {
      throw new Error(`no account with login ${login}`);
    }
    const { reset } = await this.Totp.adminReset(CLI_ACTOR, id, cliContext());
    this.Log.success(reset ? `MFA reset for ${login}` : `No MFA enrolment for ${login}`);
  }
}
