import type { Principal } from '@spinajs/authz';
import { Access, CurrentPrincipal } from '@spinajs/authz-http';
import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Body, Del, Get, Ok, Param, Patch, Post, Query } from '@spinajs/http';
import { GroupService, parseSubjectLabel } from '@spinajs/teams';
import '../schemas/provider.js';

import { done, membersJson } from '../http/answers.js';
import { guarded } from '../http/errors.js';
import { GROUP } from '../http/refs.js';
import { definedOnly, pageOf, pageQuery, sizeQuery } from '../http/request.js';
import { AddGroupMemberBody, MoveGroupBody, UpdateGroupBody } from '../schemas/bodies.js';

/**
 * One group and its members.
 * Every route sits on `@Access` at the group: `group:read`, `group:update`, `group:delete`, `group:members.manage`. Team roles at the group's team reach the group (it is below the team). Path subjects are URL-encoded `user:<id>`, `group:<id>` or `team:<id>`.
 * @tags Groups
 */
@BasePath('groups')
export class GroupsController extends BaseController {
  @Autoinject(GroupService)
  protected Groups: GroupService;

  /**
   * Read a group
   * @param group The group id
   * @response 200 {TeamsGroup} The group
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `group:read` at the group (also for an id that does not exist)
   * @response 404 {TeamsError} not_found: the group does not exist
   */
  @Get(':group')
  @Access('group:read', { resource: GROUP })
  public async get(@CurrentPrincipal() caller: Principal, @Param() group: string) {
    return guarded(async () => new Ok(await this.Groups.getGroup(caller, group)));
  }

  /**
   * Change a group
   * Changes the slug, name or description; `description: null` clears it.
   * @param group The group id
   * @response 200 {TeamsGroup} The changed group
   * @response 400 Bad request: the body does not match UpdateGroupBody (at least one key)
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `group:update` at the group
   * @response 404 {TeamsError} not_found: the group does not exist
   * @response 409 {TeamsError} conflict: the slug is taken in the team
   */
  @Patch(':group')
  @Access('group:update', { resource: GROUP })
  public async update(@CurrentPrincipal() caller: Principal, @Param() group: string, @Body() body: UpdateGroupBody) {
    return guarded(async () => new Ok(await this.Groups.updateGroup(caller, group, definedOnly({ slug: body.slug, name: body.name, description: body.description }))));
  }

  /**
   * Delete a group
   * Deletes the group and unlinks its members from the team. A group with sub-groups is refused.
   * @param group The group id
   * @response 200 {TeamsOk} Deleted
   * @response 400 {TeamsError} invalid_request: the group has sub-groups
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `group:delete` at the group
   * @response 404 {TeamsError} not_found: the group does not exist
   */
  @Del(':group')
  @Access('group:delete', { resource: GROUP })
  public async remove(@CurrentPrincipal() caller: Principal, @Param() group: string) {
    return guarded(async () => {
      await this.Groups.deleteGroup(caller, group);
      return done();
    });
  }

  /**
   * Move a group
   * Moves the group to another team (`teamId`) and/or under another group of its team (`parentId`, null for none), re-linking its members.
   * @param group The group id
   * @response 200 {TeamsGroup} The moved group
   * @response 400 Bad request: the body does not match MoveGroupBody, or {TeamsError} invalid_request / set_cycle
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `group:update` at the group, or no `group:create` at the target team
   * @response 404 {TeamsError} not_found: the group, team or parent does not exist
   */
  @Post(':group/move')
  @Access('group:update', { resource: GROUP })
  public async move(@CurrentPrincipal() caller: Principal, @Param() group: string, @Body() body: MoveGroupBody) {
    return guarded(async () => new Ok(await this.Groups.moveGroup(caller, group, definedOnly({ teamId: body.teamId, parentId: body.parentId }))));
  }

  /**
   * List group members
   * Every assignment at the group, one entry per subject and role.
   * @param group The group id
   * @param page Page number from 0 (default 0)
   * @param size Page size, 1 to 200 (default 50)
   * @response 200 {TeamsMemberPage} One page of members
   * @response 400 Bad request: a query parameter does not match its schema
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `group:read` at the group
   * @response 404 {TeamsError} not_found: the group does not exist
   */
  @Get(':group/members')
  @Access('group:read', { resource: GROUP })
  public async members(@CurrentPrincipal() caller: Principal, @Param() group: string, @Query(pageQuery()) page?: number, @Query(sizeQuery()) size?: number) {
    return guarded(async () => new Ok(membersJson(await this.Groups.members(caller, group, pageOf(page, size)))));
  }

  /**
   * Add a group member
   * Adds a user, group or team to the group.
   * @param group The group id
   * @response 200 {TeamsOk} Added
   * @response 400 Bad request: the body does not match AddGroupMemberBody, or {TeamsError} set_cycle / set_too_deep
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `group:members.manage` at the group
   * @response 404 {TeamsError} not_found: the group does not exist
   * @response 409 {TeamsError} conflict: the subject is a member already
   */
  @Post(':group/members')
  @Access('group:members.manage', { resource: GROUP })
  public async addMember(@CurrentPrincipal() caller: Principal, @Param() group: string, @Body() body: AddGroupMemberBody) {
    return guarded(async () => {
      await this.Groups.addGroupMember(caller, group, parseSubjectLabel(body.subject));
      return done();
    });
  }

  /**
   * Remove a group member
   * @param group The group id
   * @param subject `user:<id>`, `group:<id>` or `team:<id>`, URL-encoded
   * @response 200 {TeamsOk} Removed
   * @response 400 {TeamsError} invalid_request: a malformed subject
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `group:members.manage` at the group
   * @response 404 {TeamsError} not_found: the group does not exist or the subject is no member
   */
  @Del(':group/members/:subject')
  @Access('group:members.manage', { resource: GROUP })
  public async removeMember(@CurrentPrincipal() caller: Principal, @Param() group: string, @Param() subject: string) {
    return guarded(async () => {
      await this.Groups.removeGroupMember(caller, group, parseSubjectLabel(subject));
      return done();
    });
  }
}
