import type { Principal } from '@spinajs/authz';
import { CurrentPrincipal, IsAuthenticated } from '@spinajs/authz-http';
import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Get, Ok, Policy } from '@spinajs/http';
import { TeamService } from '@spinajs/teams';

import { guarded } from '../http/errors.js';

/**
 * The signed-in principal's teams.
 * The route checks authentication only, as authz-http's `/user/access` routes do: it answers about the caller and nothing else, and no permission names that.
 * @tags User teams
 */
@BasePath('user')
export class UserTeamsController extends BaseController {
  @Autoinject(TeamService)
  protected Teams: TeamService;

  /**
   * My teams and groups
   * The teams and groups where the caller holds a role, directly or through a group or team set, each with those roles. Empty for a caller in no team.
   * @response 200 {TeamsUserTeams} The caller's teams and groups
   * @response 401 Unauthorized: a valid session or token is required
   */
  @Get('teams')
  @Policy(IsAuthenticated)
  public async list(@CurrentPrincipal() caller: Principal) {
    return guarded(async () => new Ok(await this.Teams.teamsOf(caller)));
  }
}
