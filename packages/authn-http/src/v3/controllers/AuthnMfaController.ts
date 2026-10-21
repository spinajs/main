import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Body, Ok, Policy, Post } from '@spinajs/http';
import { AuthnService, SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthenticationResult, Session } from '@spinajs/authn/contracts';

import { ClientContext } from '../../args/authn.js';
import { AuthnMfaChallengeBody, AuthnMfaCodeBody, AuthnMfaStepUpBody, AuthnMfaVerifyBody } from '../../dto/mfa.js';
import { refused, unauthenticated } from '../../policies/v3/errors.js';
import { mfaPolicyOf } from '../../policies/v3/mfa.js';
import { ActiveSessionOnly, PendingSessionOnly } from '../../policies/v3/session-state.js';
import { OnInvalidInput } from '../../validation/answers.js';
import { uniformFailure } from '../../validation/login.js';
import type { AuthnClientContext } from '../client.js';
import { AcceptedResponse, NO_STORE, authnFailureResponse, authnSessionCookie } from '../responses.js';
import { answerFor, contextOf, pendingSteps, startedSession } from '../routes.js';

/** completeMfa's step for recovery codes (contracts: MfaStep.name, AuthnService.completeMfa). */
const RECOVERY_STEP = 'recovery';

const ACK: Readonly<{ Ok: true }> = Object.freeze({ Ok: true });

/** What a challenge answers whatever happened, a body the schema refuses included: it tells nothing about the account. */
const accepted = (): AcceptedResponse => new AcceptedResponse({ ...ACK }, { Headers: [NO_STORE] });

/**
 * Completes the login of a pending (pre-MFA) session (A09, A10). Only a pending session reaches these routes: none
 * answers 401, an active one 403. Success elevates the session to aal2 under a new id, keeping its data; a failure
 * answers the login failure body and leaves the session pending. The step-up route is the reverse: only an active
 * session reaches it (a pending one answers 403), and success reissues it at aal2 under a new id. Those session checks
 * are policies, so they answer before the body is read; a body the schema refuses then answers the login failure body.
 * @tags Authentication
 */
@BasePath('auth')
export class AuthnMfaController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Autoinject(SessionIssuer)
  protected Sessions!: SessionIssuer;

  @Config('authn.mfa.policy.service')
  protected MfaPolicyService: string;

  /**
   * Verify an MFA step
   * Body `{ code, step? }`: `step` when it is one of the pending steps, else the first pending step.
   * @returns {AuthnPrincipalAnswer} The principal summary of the elevated session
   * @response 401 {AuthnUnauthorized} No session, or a wrong, missing or throttled code
   * @response 403 {AuthnError} mfa_not_pending: the session is active
   * @security cookieAuth
   */
  @Post('mfa/verify')
  @Policy(PendingSessionOnly)
  @OnInvalidInput(uniformFailure)
  public async verify(@Body({ required: true }) body: AuthnMfaVerifyBody, @ClientContext() client: AuthnClientContext) {
    return this.complete(client, body.code, false, body.step);
  }

  /**
   * Use a recovery code
   * Body `{ code }`: a single-use recovery code instead of a step.
   * @returns {AuthnPrincipalAnswer} The principal summary of the elevated session
   * @response 401 {AuthnUnauthorized} No session, or a wrong, used or throttled code
   * @response 403 {AuthnError} mfa_not_pending: the session is active
   * @security cookieAuth
   */
  @Post('mfa/recovery')
  @Policy(PendingSessionOnly)
  @OnInvalidInput(uniformFailure)
  public async recovery(@Body({ required: true }) body: AuthnMfaCodeBody, @ClientContext() client: AuthnClientContext) {
    return this.complete(client, body.code, true);
  }

  /**
   * Step up the active session
   * Body `{ step?, code }`: `step` is an MFA step the identity is enrolled in, or `recovery` for a recovery code.
   * @returns {AuthnPrincipalAnswer} The principal summary of the session at aal2
   * @response 401 {AuthnUnauthorized} No session, or a wrong, malformed or throttled code
   * @response 403 {AuthnError} mfa_pending: the session is pending
   * @security cookieAuth
   */
  @Post('mfa/step-up')
  @Policy(ActiveSessionOnly)
  @OnInvalidInput(uniformFailure)
  public async stepUp(@Body({ required: true }) body: AuthnMfaStepUpBody, @ClientContext() client: AuthnClientContext) {
    const session = client.session;
    if (!session) throw unauthenticated('this route needs a session');
    if (session.handle.state !== 'active') throw refused('mfa_pending', 'complete the pending second factor instead');

    const step = body.step ?? (await this.firstEnrolledStep(session));
    if (step === null) return authnFailureResponse();

    const authn = await this.Container.resolve(AuthnService);
    return this.answer(authn, await authn.stepUp(session.handle, step, body.code, contextOf(client, 'login', session.handle)), false);
  }

  /**
   * Send the code of an MFA step
   * Body `{ step? }`: asks the pending step (as in `mfa/verify`) that delivers its code out of band, such as the email
   * code, to send it. 202 `{ Ok: true }` whether or not a step sends anything and whether or not the send worked, so the
   * answer tells nothing about the account; a step with no `challenge` needs none. Repeats are throttled by the step.
   * @response 202 {AuthnOk} Always { Ok: true }
   * @security cookieAuth
   */
  @Post('mfa/challenge')
  @Policy(PendingSessionOnly)
  @OnInvalidInput(accepted)
  public async challenge(@Body() body: AuthnMfaChallengeBody, @ClientContext() client: AuthnClientContext) {
    const session = this.pendingSession(client);
    const steps = await pendingSteps(this.Container, session, this.MfaPolicyService);
    const asked = (body as AuthnMfaChallengeBody | null)?.step;
    const name = asked !== undefined && steps.includes(asked) ? asked : steps[0];
    const step = name === undefined ? undefined : (await (await mfaPolicyOf(this.Container, this.MfaPolicyService)).steps()).get(name);
    if (typeof step?.challenge === 'function') {
      try {
        await step.challenge(session.identity, contextOf(client, 'login', session.handle));
      } catch (err) {
        // The name only: an error can carry the address or the code.
        this._log.warn({ errorName: (err as Error)?.name ?? typeof err }, 'An MFA challenge failed: ${errorName}');
      }
    }
    return accepted();
  }

  protected pendingSession(client: AuthnClientContext) {
    const session = client.session;
    if (!session) throw unauthenticated('this route needs a pending session');
    if (session.handle.state !== 'pending') throw refused('mfa_not_pending', 'this session needs no second factor');
    return session;
  }

  /** The step: `asked` when it is pending, else the first pending one; RECOVERY_STEP for a recovery code. */
  protected async complete(client: AuthnClientContext, code: string, recovery: boolean, asked?: string) {
    const session = this.pendingSession(client);

    let step = RECOVERY_STEP;
    if (!recovery) {
      const steps = await pendingSteps(this.Container, session, this.MfaPolicyService);
      const chosen = asked !== undefined && steps.includes(asked) ? asked : steps[0];
      if (chosen === undefined) return authnFailureResponse();
      step = chosen;
    }

    // Per call: an eager AuthnService builds its checked neighbours, missing in apps without them.
    const authn = await this.Container.resolve(AuthnService);
    return this.answer(authn, await authn.completeMfa(session.handle, step, code, contextOf(client, 'login', session.handle)), true);
  }

  protected async firstEnrolledStep(session: Session): Promise<string | null> {
    const policy = await mfaPolicyOf(this.Container, this.MfaPolicyService);
    for (const s of (await policy.steps()).values()) if (await s.enrolled(session.identity)) return s.name;
    return null;
  }

  // A step-up reissues a session that already started: its ActiveRole, maybe switched since, stays.
  protected async answer(authn: AuthnService, result: AuthenticationResult, started: boolean) {
    if (result.status === 'failure') return authnFailureResponse(result.reason === 'throttled' ? result.retryAfterSeconds : undefined);
    if (result.status !== 'success' || !result.session) return authnFailureResponse();
    const principal = started ? await startedSession(this.Container, this.Sessions, 'mfa', result.session, await authn.principalOf(result)) : await authn.principalOf(result);
    return new Ok(await answerFor(this.Container, 'mfa', principal), { Coockies: [authnSessionCookie(this._cfg, result.session)], Headers: [NO_STORE] });
  }
}
