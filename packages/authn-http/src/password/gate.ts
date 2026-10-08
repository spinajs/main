import { Autoinject, Container } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import { PasswordService } from '@spinajs/authn/contracts';

import { notFound } from '../policies/v3/errors.js';

/** 404 while no PasswordService is registered: the password routes are off (design §22.11). The first policy of the controller. */
export class PasswordServiceRegistered extends BasePolicy {
  @Autoinject(Container)
  protected Container!: IContainer;

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(_req: Request, _action: IRoute, _instance: IController): Promise<void> {
    if (!this.Container.hasRegistered(PasswordService as unknown as Class<PasswordService>)) throw notFound('not_found', 'the password routes are off: no PasswordService is registered');
  }
}
