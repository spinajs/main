import { Autoinject } from '@spinajs/di';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Orm } from '@spinajs/orm';
import { Log, Logger } from '@spinajs/log';
import { InvalidArgument } from '@spinajs/exceptions';
import { CLI_ACTOR, IdentityStore, cliContext } from '@spinajs/authn/contracts';
import { TotpService } from '../service/totp-service.js';

/** Replaces `rbac:user-enable-2fa`, which handed a TOTP secret to the operator (SR-10). */
@Command('authn:mfa-reset', 'Removes the MFA enrolment and recovery codes of an account; prints no secret')
@Argument('login', true, 'login or email')
export class MfaReset extends CliCommand {
  // Boots the ORM, which applies its Migration.OnStartup migrations, before the command runs; the identity store needs it.
  @Autoinject(Orm)
  protected Orm: Orm;

  /** Waits for the Orm's `data()` seeds too: an app process serves only after them. */
  public async resolve(): Promise<void> {
    await super.resolve();
    await this.Orm.Migrator.ready();
  }

  @Logger('authn-totp')
  protected Log: Log;

  @Autoinject(IdentityStore, { check: true })
  protected Identities: IdentityStore;

  @Autoinject(TotpService)
  protected Totp: TotpService;

  public async execute(login: string): Promise<void> {
    const id = await this.Identities.findByLogin(login);
    if (!id) {
      throw new InvalidArgument(`no account with login ${login}`);
    }
    const { reset } = await this.Totp.adminReset(CLI_ACTOR, id, cliContext());
    this.Log.success({ login }, reset ? 'MFA reset for ${login}' : 'No MFA enrolment for ${login}');
  }
}
