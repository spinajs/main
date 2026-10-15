import type { Class } from '@spinajs/di';
import type { BaseController } from '@spinajs/http';

/** Every controller of the package, for apps and tests that mount controllers by hand instead of by `system.dirs.controllers`. */
export const TEAMS_HTTP_CONTROLLERS: readonly Class<BaseController>[] = Object.freeze([]);
