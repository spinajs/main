import type { Principal } from '@spinajs/authz';
import { Access, CurrentPrincipal } from '@spinajs/authz-http';
import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Body, Del, Get, Ok, Param, Patch, Post, Query } from '@spinajs/http';
import { TeamService, parseSubjectLabel } from '@spinajs/teams';
import '../schemas/provider.js';

import { done, membersJson } from '../http/answers.js';
import { guarded } from '../http/errors.js';
import { TEAM } from '../http/refs.js';
import { pageOf, pageQuery, sizeQuery } from '../http/request.js';
import { AddTeamMemberBody, SetRoleBody } from '../schemas/bodies.js';

/**
 * Members of a team: users, groups and teams holding a role at the team.
 * Every route sits on `@Access` at the team: `team:read` to list, `team:members.manage` to add and remove, `team:roles.manage` to change a role. The writes run as the caller, so AuthzAdmin's guard keeps one `team.owner` per team (`last_holder`) and refuses a role above the caller's own (`escalation`). Path subjects are URL-encoded `user:<id>`, `group:<id>` or `team:<id>`.
 * @tags Team members
 */
@BasePath('teams')
export class TeamMembersController extends BaseController {
  @Autoinject(TeamService)
  protected Teams: TeamService;

  /**
   * List members
   * Every assignment at the team, one entry per subject and role.
   * @param team The team id
   * @param page Page number from 0 (default 0)
   * @param size Page size, 1 to 200 (default 50)
   * @response 200 {TeamsMemberPage} One page of members
   * @response 400 Bad request: a query parameter does not match its schema
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:read` at the team
   * @response 404 {TeamsError} not_found: the team was deleted
   */
  @Get(':team/members')
  @Access('team:read', { resource: TEAM })
  public async list(@CurrentPrincipal() caller: Principal, @Param() team: string, @Query(pageQuery()) page?: number, @Query(sizeQuery()) size?: number) {
    return guarded(async () => new Ok(membersJson(await this.Teams.members(caller, team, pageOf(page, size)))));
  }

  /**
   * Add a member
   * Assigns `role` (default `team.member`) at the team to the subject.
   * @param team The team id
   * @response 200 {TeamsOk} Added
   * @response 400 Bad request: the body does not match AddTeamMemberBody, or {TeamsError} an AuthzAdmin validation code (unknown_role, wrong_scope_type, not_assignable)
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:members.manage` at the team, or {TeamsError} escalation
   * @response 404 {TeamsError} not_found: the team was deleted
   * @response 409 {TeamsError} conflict: the subject holds that role already
   */
  @Post(':team/members')
  @Access('team:members.manage', { resource: TEAM })
  public async add(@CurrentPrincipal() caller: Principal, @Param() team: string, @Body() body: AddTeamMemberBody) {
    return guarded(async () => {
      await this.Teams.addTeamMember(caller, team, parseSubjectLabel(body.subject), body.role);
      return done();
    });
  }

  /**
   * Change a member's role
   * Replaces the subject's roles at the team with `role`, in one batch.
   * @param team The team id
   * @param subject `user:<id>`, `group:<id>` or `team:<id>`, URL-encoded
   * @response 200 {TeamsOk} Changed
   * @response 400 Bad request: the body does not match SetRoleBody, or {TeamsError} invalid_request (a malformed subject) or an AuthzAdmin validation code
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:roles.manage` at the team, or {TeamsError} escalation, last_holder
   * @response 404 {TeamsError} not_found: the team was deleted or the subject is no member
   */
  @Patch(':team/members/:subject')
  @Access('team:roles.manage', { resource: TEAM })
  public async setRole(@CurrentPrincipal() caller: Principal, @Param() team: string, @Param() subject: string, @Body() body: SetRoleBody) {
    return guarded(async () => {
      await this.Teams.setTeamRole(caller, team, parseSubjectLabel(subject), body.role);
      return done();
    });
  }

  /**
   * Remove a member
   * Revokes every role of the subject at the team.
   * @param team The team id
   * @param subject `user:<id>`, `group:<id>` or `team:<id>`, URL-encoded
   * @response 200 {TeamsOk} Removed
   * @response 400 {TeamsError} invalid_request: a malformed subject
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:members.manage` at the team, or {TeamsError} last_holder, self_lockout
   * @response 404 {TeamsError} not_found: the team was deleted or the subject is no member
   */
  @Del(':team/members/:subject')
  @Access('team:members.manage', { resource: TEAM })
  public async remove(@CurrentPrincipal() caller: Principal, @Param() team: string, @Param() subject: string) {
    return guarded(async () => {
      await this.Teams.removeTeamMember(caller, team, parseSubjectLabel(subject));
      return done();
    });
  }
}
