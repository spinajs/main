import { Autoinject, Container } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import { KeyRegistry } from '@spinajs/authn/contracts';

import { notFound } from '../policies/v3/errors.js';

/** 404 while no KeyRegistry is registered: the 3.0 key routes are off (design §22.11). The first policy of the controller. */
export class KeyRegistryRegistered extends BasePolicy {
  @Autoinject(Container)
  protected Container!: IContainer;

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(_req: Request, _action: IRoute, _instance: IController): Promise<void> {
    if (!this.Container.hasRegistered(KeyRegistry as unknown as Class<KeyRegistry>)) throw notFound('not_found', 'the key routes are off: no KeyRegistry is registered');
  }
}
