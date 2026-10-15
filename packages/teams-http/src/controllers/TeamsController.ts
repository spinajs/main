import type { Principal } from '@spinajs/authz';
import { Access, CurrentPrincipal } from '@spinajs/authz-http';
import { Autoinject } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { BaseController, BasePath, Body, Del, Get, Ok, Param, Patch, Post, Query } from '@spinajs/http';
import { TeamService } from '@spinajs/teams';

import { done } from '../http/answers.js';
import { guarded } from '../http/errors.js';
import { PARENT_TEAM, TEAM } from '../http/refs.js';
import { definedOnly, pageOf, pageQuery, sizeQuery } from '../http/request.js';
import { parseUser } from '../http/subjects.js';
import { CreateTeamBody, MoveTeamBody, TransferTeamBody, UpdateTeamBody } from '../schemas/bodies.js';

/**
 * Teams: list, create, read, change, archive, move, transfer ownership, delete, restore.
 * Every route sits on `@Access`: at the addressed team, at the parent named in the body (or `$global`) for the create, type-level for the list. TeamService checks the exact permission again. The list comes from `.accessible('team:read')`. A refused service call answers `{ error: { code, message, field? } }`.
 * @tags Teams
 */
@BasePath('teams')
export class TeamsController extends BaseController {
  @Autoinject(TeamService)
  protected Teams: TeamService;

  /**
   * List teams
   * The live teams the caller may read (`.accessible('team:read')` in TeamService). A caller who can read no team at all is refused (403): GET /user/teams answers "my teams" for everyone.
   * @param parentId Only the direct sub-teams of this team
   * @param root `true`: only root teams (not with parentId)
   * @param page Page number from 0 (default 0)
   * @param size Page size, 1 to 200 (default 50)
   * @response 200 {TeamsTeamPage} One page of teams
   * @response 400 Bad request: a query parameter does not match its schema, or {TeamsError} invalid_request (root with parentId)
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: the caller can read no team
   */
  @Get('/')
  @Access('team:read')
  public async list(@CurrentPrincipal() caller: Principal, @Query({ type: 'string', minLength: 1 }) parentId?: string, @Query() root?: boolean, @Query(pageQuery()) page?: number, @Query(sizeQuery()) size?: number) {
    return guarded(async () => {
      if (root && parentId !== undefined) throw new InvalidArgument('root and parentId exclude each other', 'root');
      const parent = root ? { parentId: null } : parentId !== undefined ? { parentId } : {};
      return new Ok(await this.Teams.listTeams(caller, { ...parent, page: pageOf(page, size) }));
    });
  }

  /**
   * Create a team
   * Creates a team; the caller becomes its `team.owner`. A root team needs `team:create` at `$global`, a sub-team `team:create` at its parent (the route checks there, and TeamService again).
   * @response 200 {TeamsTeam} The new team
   * @response 400 Bad request: the body does not match CreateTeamBody, or {TeamsError} invalid_request
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:create` at the parent (also for a parent that does not exist), or at `$global` for a root team
   * @response 404 {TeamsError} not_found: the parent team was deleted
   * @response 409 {TeamsError} conflict: the slug is taken
   */
  @Post('/')
  @Access('team:create', { resource: PARENT_TEAM })
  public async create(@CurrentPrincipal() caller: Principal, @Body() body: CreateTeamBody) {
    return guarded(async () => new Ok(await this.Teams.createTeam(caller, definedOnly({ slug: body.slug, name: body.name, description: body.description, parentId: body.parentId }))));
  }

  /**
   * Read a team
   * @param team The team id
   * @response 200 {TeamsTeam} The team
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:read` at the team (also for an id that does not exist)
   * @response 404 {TeamsError} not_found: the team was deleted
   */
  @Get(':team')
  @Access('team:read', { resource: TEAM })
  public async get(@CurrentPrincipal() caller: Principal, @Param() team: string) {
    return guarded(async () => new Ok(await this.Teams.getTeam(caller, team)));
  }

  /**
   * Change a team
   * Changes the slug, name or description; `description: null` clears it.
   * @param team The team id
   * @response 200 {TeamsTeam} The changed team
   * @response 400 Bad request: the body does not match UpdateTeamBody (at least one key)
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:update` at the team (or the team is archived)
   * @response 404 {TeamsError} not_found: the team was deleted
   * @response 409 {TeamsError} conflict: the slug is taken
   */
  @Patch(':team')
  @Access('team:update', { resource: TEAM })
  public async update(@CurrentPrincipal() caller: Principal, @Param() team: string, @Body() body: UpdateTeamBody) {
    return guarded(async () => new Ok(await this.Teams.updateTeam(caller, team, definedOnly({ slug: body.slug, name: body.name, description: body.description }))));
  }

  /**
   * Delete a team
   * Soft-deletes the team: writes under it freeze, and it is purged after `teams.deletion.graceDays`.
   * @param team The team id
   * @response 200 {TeamsOk} Deleted
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:delete` at the team
   * @response 404 {TeamsError} not_found: the team was deleted already
   */
  @Del(':team')
  @Access('team:delete', { resource: TEAM })
  public async remove(@CurrentPrincipal() caller: Principal, @Param() team: string) {
    return guarded(async () => {
      await this.Teams.deleteTeam(caller, team);
      return done();
    });
  }

  /**
   * Restore a team
   * Undoes a soft delete within the grace period; the team comes back archived if it was archived before. Refused while its parent is deleted.
   * @param team The team id
   * @response 200 {TeamsTeam} The restored team
   * @response 400 {TeamsError} invalid_request: the parent team is deleted
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:delete` at the team
   * @response 404 {TeamsError} not_found: no such team, or it was purged
   */
  @Post(':team/restore')
  @Access('team:delete', { resource: TEAM })
  public async restore(@CurrentPrincipal() caller: Principal, @Param() team: string) {
    return guarded(async () => new Ok(await this.Teams.restoreTeam(caller, team)));
  }

  /**
   * Archive a team
   * Marks the team archived: creates, updates and deletes under it are refused, reads stay allowed.
   * @param team The team id
   * @response 200 {TeamsTeam} The archived team
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:archive` at the team
   * @response 404 {TeamsError} not_found: the team was deleted
   */
  @Post(':team/archive')
  @Access('team:archive', { resource: TEAM })
  public async archive(@CurrentPrincipal() caller: Principal, @Param() team: string) {
    return guarded(async () => new Ok(await this.Teams.archiveTeam(caller, team)));
  }

  /**
   * Unarchive a team
   * @param team The team id
   * @response 200 {TeamsTeam} The team, no longer archived
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:archive` at the team
   * @response 404 {TeamsError} not_found: the team was deleted
   */
  @Post(':team/unarchive')
  @Access('team:archive', { resource: TEAM })
  public async unarchive(@CurrentPrincipal() caller: Principal, @Param() team: string) {
    return guarded(async () => new Ok(await this.Teams.unarchiveTeam(caller, team)));
  }

  /**
   * Move a team
   * Re-parents the team (`parentId`), or makes it a root team (`null`). Needs `team:create` at the new parent too (TeamService checks).
   * @param team The team id
   * @response 200 {TeamsTeam} The moved team
   * @response 400 Bad request: the body does not match MoveTeamBody, or {TeamsError} invalid_request / set_cycle (a move under itself)
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:update` at the team, or no `team:create` at the new parent
   * @response 404 {TeamsError} not_found: the team or the new parent does not exist
   */
  @Post(':team/move')
  @Access('team:update', { resource: TEAM })
  public async move(@CurrentPrincipal() caller: Principal, @Param() team: string, @Body() body: MoveTeamBody) {
    return guarded(async () => new Ok(await this.Teams.moveTeam(caller, team, body.parentId)));
  }

  /**
   * Transfer ownership
   * Grants `team.owner` to the user in `to` and revokes it from the caller, in one batch. The caller keeps `keepAs` (default `team.admin`; `null`: nothing).
   * @param team The team id
   * @response 200 {TeamsOk} Transferred
   * @response 400 Bad request: the body does not match TransferTeamBody
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:ownership.transfer` at the team, or {TeamsError} a guard refusal (last_holder, escalation)
   * @response 404 {TeamsError} not_found: the team was deleted
   */
  @Post(':team/transfer')
  @Access('team:ownership.transfer', { resource: TEAM })
  public async transfer(@CurrentPrincipal() caller: Principal, @Param() team: string, @Body() body: TransferTeamBody) {
    return guarded(async () => {
      await this.Teams.transferOwnership(caller, team, parseUser(body.to, 'to'), definedOnly({ keepAs: body.keepAs }));
      return done();
    });
  }
}
