import { AuthzClock } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import type { RbacModel } from '../model/model.js';
import { buildRbac } from './register.js';
import type { RegisterRbacOptions } from './register.js';

/** Register in a domain's container (or root) to give `authz.use: ['rbac']` the options config cannot hold. */
export abstract class RbacOptions {
  abstract options(container: IContainer): RegisterRbacOptions | Promise<RegisterRbacOptions>;
}

/** `authz.use: ['rbac']`: wires RBAC into the container of the domain that lists it. An arrow, so DI treats it as a factory. */
export const useRbac = async (container: IContainer): Promise<RbacModel> => {
  const configuration = await container.resolve<Configuration>(Configuration);
  const clock = await container.resolve<AuthzClock>(AuthzClock);
  const custom = container.hasRegistered(RbacOptions) ? await (await container.resolve<RbacOptions>(RbacOptions)).options(container) : {};
  return (await buildRbac(container, configuration, { clock, ...custom })).model;
};

DI.register(useRbac).as('rbac');
