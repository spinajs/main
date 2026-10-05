import { Autoinject, Container } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import { KeyRegistry } from '@spinajs/authn/contracts';

import { notFound } from '../policies/v3/errors.js';

const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v !== '';

/**
 * The first policy of the key routes: 404 `not_found` while no KeyRegistry is registered, or while authn.keys names no
 * audience (`challenge.audience`, else `assertion.audience`, as authn-keys reads them). Without one no challenge can be
 * issued or verified, so the group is off (design §22.11) rather than answering 500 on every challenge.
 */
export class KeyRoutesOn extends BasePolicy {
  @Autoinject(Container)
  protected Container!: IContainer;

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(_req: Request, _action: IRoute, _instance: IController): Promise<void> {
    if (!this.Container.hasRegistered(KeyRegistry as unknown as Class<KeyRegistry>)) throw notFound('not_found', 'the key routes are off');
    const config = await this.Container.resolve(Configuration);
    if (!nonEmpty(config.get<unknown>('authn.keys.challenge.audience')) && !nonEmpty(config.get<unknown>('authn.keys.assertion.audience'))) throw notFound('not_found', 'the key routes are off');
  }
}
