import type { Class } from '@spinajs/di';
import type { BaseController } from '@spinajs/http';

import { GroupsController } from './controllers/GroupsController.js';
import { InvitationsController } from './controllers/InvitationsController.js';
import { TeamGroupsController } from './controllers/TeamGroupsController.js';
import { TeamInvitationsController } from './controllers/TeamInvitationsController.js';
import { TeamMembersController } from './controllers/TeamMembersController.js';
import { TeamsController } from './controllers/TeamsController.js';
import { UserTeamsController } from './controllers/UserTeamsController.js';

/** Every controller of the package, for apps and tests that mount controllers by hand instead of by `system.dirs.controllers`. */
export const TEAMS_HTTP_CONTROLLERS: readonly Class<BaseController>[] = Object.freeze([TeamsController, TeamMembersController, TeamGroupsController, GroupsController, TeamInvitationsController, InvitationsController, UserTeamsController]);

/** The routes of teams §9 plus the restore route, as `<METHOD> <path>`. */
export const TEAMS_HTTP_ROUTES: readonly string[] = Object.freeze([
  'GET /teams',
  'POST /teams',
  'GET /teams/:team',
  'PATCH /teams/:team',
  'DELETE /teams/:team',
  'POST /teams/:team/archive',
  'POST /teams/:team/unarchive',
  'POST /teams/:team/move',
  'POST /teams/:team/transfer',
  'POST /teams/:team/restore',
  'GET /teams/:team/members',
  'POST /teams/:team/members',
  'PATCH /teams/:team/members/:subject',
  'DELETE /teams/:team/members/:subject',
  'GET /teams/:team/groups',
  'POST /teams/:team/groups',
  'GET /groups/:group',
  'PATCH /groups/:group',
  'DELETE /groups/:group',
  'POST /groups/:group/move',
  'GET /groups/:group/members',
  'POST /groups/:group/members',
  'DELETE /groups/:group/members/:subject',
  'GET /teams/:team/invitations',
  'POST /teams/:team/invitations',
  'DELETE /teams/:team/invitations/:invitation',
  'POST /teams/:team/invitations/:invitation/resend',
  'POST /invitations/accept',
  'GET /user/teams',
]);
