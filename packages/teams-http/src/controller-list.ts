import type { Class } from '@spinajs/di';
import type { BaseController } from '@spinajs/http';

import { GroupsController } from './controllers/GroupsController.js';
import { TeamGroupsController } from './controllers/TeamGroupsController.js';
import { TeamMembersController } from './controllers/TeamMembersController.js';
import { TeamsController } from './controllers/TeamsController.js';

/** Every controller of the package, for apps and tests that mount controllers by hand instead of by `system.dirs.controllers`. */
export const TEAMS_HTTP_CONTROLLERS: readonly Class<BaseController>[] = Object.freeze([TeamsController, TeamMembersController, TeamGroupsController, GroupsController]);
