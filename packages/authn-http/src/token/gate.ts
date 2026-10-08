import { Autoinject, Container } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import { TokenService } from '@spinajs/authn/contracts';

import { notFound } from '../policies/v3/errors.js';

/**
 * 404 while no TokenService is registered: the 3.0 token routes are off (design §22.11). The first policy of the
 * controller. Not exported by the package barrel (src/token/index.ts is the 2.x one).
 */
export class TokenServiceRegistered extends BasePolicy {
  @Autoinject(Container)
  protected Container!: IContainer;

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(_req: Request, _action: IRoute, _instance: IController): Promise<void> {
    if (!this.Container.hasRegistered(TokenService as unknown as Class<TokenService>)) throw notFound('not_found', 'the token routes are off: no TokenService is registered');
  }
}
