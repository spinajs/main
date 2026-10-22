import { Config } from '@spinajs/configuration';
import '../register-schema.js';
import { Autoinject, Container, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, AfterContext } from '@spinajs/hooks';
import { PasswordService } from '@spinajs/authn/contracts';
import type { AuthnContext } from '@spinajs/authn/contracts';

import type { RegistrationOutput } from '../hooks.js';

/**
 * The mail of a self-service registration (`POST /auth/register`), once the registrar answered: a verification mail to
 * a created account, an account-exists mail to the owner of a taken address while `authn.http.registration.notifyExisting`
 * is on. Both outcomes take this one path, and a mail that cannot be requested is logged, never shown: the route answers
 * the same 202 either way, so the answer tells a stranger nothing about who has an account.
 *
 * Registered by authn-http. To change a mail, extend it and override {@link RegistrationMailHook.send}; to send none,
 * `DI.unregister(RegistrationMailHook)` before the application boots.
 */
@Injectable(ActionHook)
export class RegistrationMailHook extends ActionHook<'authn.registration'> {
  readonly actions: readonly ActionPattern[] = ['authn.registration'];

  @Autoinject(Container)
  protected Container!: IContainer;

  @Config('authn.http.registration.notifyExisting')
  protected NotifyExisting: boolean;

  @Logger('authn-http')
  protected Log: Log;

  public async after(ctx: AfterContext<'authn.registration'>): Promise<void> {
    try {
      await this.send(ctx.output, ctx.input.ctx);
    } catch (err) {
      // The class only: a transport error can carry the address.
      this.Log.warn({ errorName: err instanceof Error ? err.constructor.name : typeof err }, 'A registration mail could not be requested: ${errorName}');
    }
  }

  protected async send(outcome: RegistrationOutput, ctx: AuthnContext): Promise<void> {
    const passwords = await this.Container.resolve<PasswordService>(PasswordService);
    if (outcome.status === 'created') await passwords.requestVerification?.(outcome.id, ctx);
    else if (this.NotifyExisting !== false) await passwords.notifyAccountExists?.(outcome.id, ctx);
  }
}
