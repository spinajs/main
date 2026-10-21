import { Autoinject, Container } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import { ImpersonationGuard, JwsSigner, PrincipalFactory, RoleSource } from '@spinajs/authn/contracts';

import { notFound } from './errors.js';

// Design §22.11: a route group is on only while its service is registered. As the first policy scope of the controller
// it answers 404 before any authentication policy, so a group that is off looks like no route at all.

/** A route group gate over the container it resolves from: 404 `not_found` with `offMessage` unless `service` is registered. */
export class ServiceGate extends BasePolicy {
  @Autoinject(Container)
  protected Container!: IContainer;

  constructor(
    protected readonly service: Class<unknown>,
    protected readonly offMessage: string,
  ) {
    super();
  }

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(_req: Request, _action: IRoute, _instance: IController): Promise<void> {
    this.require(this.service, this.offMessage);
  }

  protected require(service: Class<unknown>, message: string): void {
    if (!this.Container.hasRegistered(service)) throw notFound('not_found', message);
  }
}

/** The gate of a group that is on while `service` is registered, else 404 `not_found` with `message`. */
export function serviceRegistered(service: Class<unknown>, message: string): new () => ServiceGate {
  class ServiceRegistered extends ServiceGate {
    constructor() {
      super(service, message);
    }
  }
  return ServiceRegistered;
}

/** 404 while no RoleSource or no PrincipalFactory is registered: the role switch routes are off. */
export class RoleSourceRegistered extends serviceRegistered(RoleSource, 'role switch is off: no RoleSource is registered') {
  public async execute(req: Request, action: IRoute, instance: IController): Promise<void> {
    await super.execute(req, action, instance);
    this.require(PrincipalFactory, 'role switch is off: no PrincipalFactory is registered');
  }
}

/** 404 while no ImpersonationGuard is registered: the impersonation routes are off. */
export class ImpersonationGuardRegistered extends serviceRegistered(ImpersonationGuard, 'impersonation is off: no ImpersonationGuard is registered') {}

/** 404 while no JwsSigner is registered: the JWKS route is off. */
export class JwsSignerRegistered extends serviceRegistered(JwsSigner, 'the JWKS route is off: no JwsSigner is registered') {}
