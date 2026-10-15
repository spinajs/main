import type { Principal } from '@spinajs/authz';
import { Access, CurrentPrincipal } from '@spinajs/authz-http';
import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Body, Get, Ok, Param, Post, Query } from '@spinajs/http';
import { GroupService } from '@spinajs/teams';
import '../schemas/provider.js';

import { guarded } from '../http/errors.js';
import { TEAM } from '../http/refs.js';
import { definedOnly, pageOf, pageQuery, sizeQuery } from '../http/request.js';
import { CreateGroupBody } from '../schemas/bodies.js';

/**
 * The groups of a team.
 * The list sits on `team:read` at the team and comes from `.accessible('group:read').within(team)` in GroupService; creating needs `group:create` at the team.
 * @tags Team groups
 */
@BasePath('teams')
export class TeamGroupsController extends BaseController {
  @Autoinject(GroupService)
  protected Groups: GroupService;

  /**
   * List the groups of a team
   * The groups at or below the team the caller may read, nested ones included.
   * @param team The team id
   * @param page Page number from 0 (default 0)
   * @param size Page size, 1 to 200 (default 50)
   * @response 200 {TeamsGroupPage} One page of groups
   * @response 400 Bad request: a query parameter does not match its schema
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:read` at the team
   * @response 404 {TeamsError} not_found: the team was deleted
   */
  @Get(':team/groups')
  @Access('team:read', { resource: TEAM })
  public async list(@CurrentPrincipal() caller: Principal, @Param() team: string, @Query(pageQuery()) page?: number, @Query(sizeQuery()) size?: number) {
    return guarded(async () => new Ok(await this.Groups.listGroups(caller, team, pageOf(page, size))));
  }

  /**
   * Create a group
   * Creates a group in the team (or inside `parentId`, a group of the same team) and links its members into the team's.
   * @param team The team id
   * @response 200 {TeamsGroup} The new group
   * @response 400 Bad request: the body does not match CreateGroupBody, or {TeamsError} invalid_request (a parent group of another team)
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `group:create` at the team
   * @response 404 {TeamsError} not_found: the team or the parent group does not exist
   * @response 409 {TeamsError} conflict: the slug is taken in the team
   */
  @Post(':team/groups')
  @Access('group:create', { resource: TEAM })
  public async create(@CurrentPrincipal() caller: Principal, @Param() team: string, @Body() body: CreateGroupBody) {
    return guarded(async () => new Ok(await this.Groups.createGroup(caller, team, definedOnly({ slug: body.slug, name: body.name, description: body.description, parentId: body.parentId }))));
  }
}
