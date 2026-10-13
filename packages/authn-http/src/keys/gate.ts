import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { Autoinject, Container } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import { KeyRegistry } from '@spinajs/authn/contracts';

import { notFound } from '../policies/v3/errors.js';

/**
 * The first policy of the key routes: 404 `not_found` while no KeyRegistry is registered, or while authn.keys names no
 * audience (`challenge.audience`, else `assertion.audience`, as authn-keys reads them). Without one no challenge can be
 * issued or verified, so the group is off (design §22.11) rather than answering 500 on every challenge.
 */
export class KeyRoutesOn extends BasePolicy {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Config('authn.keys.challenge.audience')
  protected ChallengeAudience: string | null | undefined;

  @Config('authn.keys.assertion.audience')
  protected AssertionAudience: string | null | undefined;

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(_req: Request, _action: IRoute, _instance: IController): Promise<void> {
    if (!this.Container.hasRegistered(KeyRegistry as unknown as Class<KeyRegistry>)) throw notFound('not_found', 'the key routes are off');
    if (!(this.ChallengeAudience ?? this.AssertionAudience)) throw notFound('not_found', 'the key routes are off');
  }
}
