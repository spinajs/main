import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Body, Ok, Policy, Post } from '@spinajs/http';
import { PasswordService } from '@spinajs/authn/contracts';

import { ClientContext } from '../../args/authn.js';
import { AuthnVerifyBody } from '../../dto/verification.js';
import { AddressVerificationRegistered, tooManyRequests } from '../../password/index.js';
import { activeSessionOf } from '../../policies/v3/principal.js';
import { IpThrottle } from '../../middleware/ip-throttle.js';
import { OnInvalidInput, byField, unknownField } from '../../validation/answers.js';
import type { AuthnClientContext } from '../client.js';
import { Authenticated, NoImpersonationPolicy, NoTokenAuthPolicy } from '../index.js';
import { AcceptedResponse, NO_STORE, badRequest } from '../responses.js';
import { contextOf } from '../routes.js';

const ACK: Readonly<{ Ok: true }> = Object.freeze({ Ok: true });

// One answer for every refused secret, so it tells a used link from an expired or a forged one apart for nobody (A02).
const invalidSecret = () => badRequest('invalid_secret', 'the verification link is invalid or has expired');

/**
 * Address verification routes over the optional `requestVerification` and `redeemVerification` of the PasswordService
 * (FEAT-2, A32). Off (404) while the registered PasswordService offers neither, or none is registered.
 * @tags Authentication
 */
@BasePath('/')
@Policy(AddressVerificationRegistered)
export class AuthnVerificationController extends BaseController {
  @Autoinject(PasswordService, { optional: true })
  protected Passwords: PasswordService | undefined;

  /**
   * Request a verification mail
   * Mails a single-use link to the address of the session's account. 202 `{ Ok: true }` whether or not a mail goes out
   * (an address already verified gets none); 429 with Retry-After when throttled. A session only: 403
   * `session_required` for a token or key, 403 `impersonating` while impersonating.
   * @response 202 {AuthnOk} Always { Ok: true }
   * @security cookieAuth
   */
  @Post('auth/verify/request')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async request(@ClientContext() client: AuthnClientContext) {
    const session = activeSessionOf(client);
    const result = await this.Passwords!.requestVerification!(session.identity, contextOf(client, 'request', session.handle));
    if (result.status === 'throttled') return tooManyRequests('too many verification requests, try again later', result.retryAfterSeconds);
    return new AcceptedResponse({ ...ACK }, { Headers: [NO_STORE] });
  }

  /**
   * Verify the address
   * Body `{ secret }`, the secret of the verification link. 200 `{ Ok: true }`; any refused secret, a missing one
   * included, 400 `invalid_secret` with one body. 429 with Retry-After while the client ip is throttled (the `reset` flow).
   * @returns {AuthnOk} The address is verified
   * @response 400 {AuthnError} invalid_secret or invalid_field
   * @security []
   */
  @Post('auth/verify')
  @IpThrottle('reset', (retryAfter) => tooManyRequests('too many verification attempts, try again later', retryAfter))
  @OnInvalidInput(byField({ secret: invalidSecret }, unknownField))
  public async verify(@Body({ required: true }) body: AuthnVerifyBody, @ClientContext() client: AuthnClientContext) {
    const result = await this.Passwords!.redeemVerification!(body.secret, contextOf(client, 'request'));
    if (result.status === 'throttled') return tooManyRequests('too many verification attempts, try again later', result.retryAfterSeconds);
    return result.status === 'verified' ? new Ok({ ...ACK }, { Headers: [NO_STORE] }) : invalidSecret();
  }
}
