import { Autoinject, Container } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import { ImpersonationGuard, RoleSource } from '@spinajs/authn/contracts';

import { notFound } from './errors.js';

// Design §22.11: a route group is on only while its service is registered. As the first policy scope of the controller
// it answers 404 before any authentication policy, so a group that is off looks like no route at all.

/** 404 while no RoleSource is registered: the role switch routes are off. */
export class RoleSourceRegistered extends BasePolicy {
  @Autoinject(Container)
  protected Container!: IContainer;

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(_req: Request, _action: IRoute, _instance: IController): Promise<void> {
    if (!this.Container.hasRegistered(RoleSource as unknown as Class<RoleSource>)) throw notFound('not_found', 'role switch is off: no RoleSource is registered');
  }
}

/** 404 while no ImpersonationGuard is registered: the impersonation routes are off. */
export class ImpersonationGuardRegistered extends BasePolicy {
  @Autoinject(Container)
  protected Container!: IContainer;

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(_req: Request, _action: IRoute, _instance: IController): Promise<void> {
    if (!this.Container.hasRegistered(ImpersonationGuard as unknown as Class<ImpersonationGuard>)) throw notFound('not_found', 'impersonation is off: no ImpersonationGuard is registered');
  }
}
