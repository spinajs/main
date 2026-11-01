import type { IContainer } from '@spinajs/di';

import type { RegisterRbacOptions } from './wire.js';

/** Register in a domain's container (or root) to give the RbacModel DI builds the options config cannot hold. */
export abstract class RbacOptions {
  abstract options(container: IContainer): RegisterRbacOptions | Promise<RegisterRbacOptions>;
}
