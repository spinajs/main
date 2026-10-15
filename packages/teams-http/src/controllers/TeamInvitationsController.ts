import type { Principal } from '@spinajs/authz';
import { Access, CurrentPrincipal } from '@spinajs/authz-http';
import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Body, Del, Get, Ok, Param, Post, Query } from '@spinajs/http';
import { InvitationService } from '@spinajs/teams';
import '../schemas/provider.js';

import { NO_STORE, done } from '../http/answers.js';
import { guarded } from '../http/errors.js';
import { TEAM } from '../http/refs.js';
import { definedOnly, pageOf, pageQuery, sizeQuery } from '../http/request.js';
import { CreateInvitationBody } from '../schemas/bodies.js';

/**
 * Invitations to a team or one of its groups.
 * Every route sits on `team:invitations.manage` at the team. The inviter must be able to grant the role (no escalation through invitations). The token is shown once, in the create answer sent with `Cache-Control: no-store`, or in the invitation mail; it is stored only as an HMAC.
 * @tags Team invitations
 */
@BasePath('teams')
export class TeamInvitationsController extends BaseController {
  @Autoinject(InvitationService)
  protected Invitations: InvitationService;

  /**
   * List invitations
   * The team's invitations, revoked and expired ones included. A listing never carries a token or its hash.
   * @param team The team id
   * @param page Page number from 0 (default 0)
   * @param size Page size, 1 to 200 (default 50)
   * @response 200 {TeamsInvitationPage} One page of invitations
   * @response 400 Bad request: a query parameter does not match its schema
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:invitations.manage` at the team
   * @response 404 {TeamsError} not_found: the team was deleted
   */
  @Get(':team/invitations')
  @Access('team:invitations.manage', { resource: TEAM })
  public async list(@CurrentPrincipal() caller: Principal, @Param() team: string, @Query(pageQuery()) page?: number, @Query(sizeQuery()) size?: number) {
    return guarded(async () => new Ok(await this.Invitations.list(caller, team, pageOf(page, size))));
  }

  /**
   * Create an invitation
   * Invites to the team (or to `groupId`) with `role`. With `email` the invitation is mailed and only that verified email may accept it; without, the token is a shareable link. The answer holds the token, shown once, with `Cache-Control: no-store`.
   * @param team The team id
   * @response 200 {TeamsInvitationCreated} The invitation and its token
   * @response 400 Bad request: the body does not match CreateInvitationBody, or {TeamsError} invalid_request / an AuthzAdmin validation code (a role that does not fit the scope)
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:invitations.manage` at the team, or {TeamsError} escalation: the inviter cannot grant the role
   * @response 404 {TeamsError} not_found: the team or the group does not exist
   */
  @Post(':team/invitations')
  @Access('team:invitations.manage', { resource: TEAM })
  public async create(@CurrentPrincipal() caller: Principal, @Param() team: string, @Body() body: CreateInvitationBody) {
    return guarded(async () => {
      const { invitation, token } = await this.Invitations.create(caller, definedOnly({ teamId: team, groupId: body.groupId, role: body.role, email: body.email, maxUses: body.maxUses, expiresInHours: body.expiresInHours }));
      return new Ok({ invitation, token }, { Headers: [NO_STORE] });
    });
  }

  /**
   * Revoke an invitation
   * Its token opens nothing from then on; roles already given by it stay.
   * @param team The team id
   * @param invitation The invitation id
   * @response 200 {TeamsOk} Revoked
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:invitations.manage` at the team
   * @response 404 {TeamsError} not_found or invitation_unknown: the team has no such invitation
   */
  @Del(':team/invitations/:invitation')
  @Access('team:invitations.manage', { resource: TEAM })
  public async revoke(@CurrentPrincipal() caller: Principal, @Param() team: string, @Param() invitation: string) {
    return guarded(async () => {
      await this.Invitations.revoke(caller, team, invitation);
      return done();
    });
  }

  /**
   * Resend an invitation
   * Mails the email invitation again with a new token (the old one stops working) and sets `lastSentAt`. The answer does not carry the token.
   * @param team The team id
   * @param invitation The invitation id
   * @response 200 {TeamsInvitation} The invitation
   * @response 400 {TeamsError} invalid_request: the invitation has no email
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:invitations.manage` at the team
   * @response 404 {TeamsError} not_found or invitation_unknown: the team has no such invitation
   * @response 409 {TeamsError} invitation_expired, invitation_revoked or invitation_used_up
   */
  @Post(':team/invitations/:invitation/resend')
  @Access('team:invitations.manage', { resource: TEAM })
  public async resend(@CurrentPrincipal() caller: Principal, @Param() team: string, @Param() invitation: string) {
    return guarded(async () => {
      return new Ok(await this.Invitations.resend(caller, team, invitation));
    });
  }
}
