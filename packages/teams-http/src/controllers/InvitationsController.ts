import type { Principal } from '@spinajs/authz';
import { CurrentPrincipal, IsAuthenticated } from '@spinajs/authz-http';
import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Body, Ok, Policy, Post } from '@spinajs/http';
import { InvitationService } from '@spinajs/teams';

import { NO_STORE } from '../http/answers.js';
import { guarded } from '../http/errors.js';
import { AcceptInvitationBody } from '../schemas/bodies.js';

/**
 * Accepting an invitation.
 * The route checks authentication only, as no permission names this action: the token is the authorisation. InvitationService checks expiry, revocation, uses and the invited email, and assigns the role (or adds the group member) as SYSTEM with reason `invitation:<id>`. A new user signs up first, through any login flow, then accepts with the token the client kept.
 * @tags Invitations
 */
@BasePath('invitations')
export class InvitationsController extends BaseController {
  @Autoinject(InvitationService)
  protected Invitations: InvitationService;

  /**
   * Accept an invitation
   * Joins the caller to the invitation's team or group. Accepting the same invitation again answers the same (idempotent). Sent with `Cache-Control: no-store`.
   * @response 200 {TeamsInvitationAccepted} The team, group and role the caller joined with
   * @response 400 Bad request: the body does not match AcceptInvitationBody
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {TeamsError} invitation_email_mismatch (the caller's verified email is another, or none) or invitation_not_a_user
   * @response 404 {TeamsError} invitation_unknown: no invitation has this token (or a resend replaced it)
   * @response 409 {TeamsError} invitation_expired, invitation_revoked or invitation_used_up
   */
  @Post('accept')
  @Policy(IsAuthenticated)
  public async accept(@CurrentPrincipal() caller: Principal, @Body() body: AcceptInvitationBody) {
    return guarded(async () => new Ok(await this.Invitations.accept(caller, body.token), { Headers: [NO_STORE] }));
  }
}
