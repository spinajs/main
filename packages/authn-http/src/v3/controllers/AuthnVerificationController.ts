import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Ok, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { PasswordService } from '@spinajs/authn/contracts';

import { AddressVerificationRegistered, secretField, tooManyRequests } from '../../password/index.js';
import { activeSessionOf } from '../../policies/v3/principal.js';
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
   * @security cookieAuth
   */
  @Post('auth/verify/request')
  @Policy([Authenticated, NoTokenAuthPolicy, NoImpersonationPolicy])
  public async request(@Req() req: Request) {
    const session = activeSessionOf(req);
    const result = await this.Passwords!.requestVerification!(session.identity, contextOf(req, 'request', session.handle));
    if (result.status === 'throttled') return tooManyRequests('too many verification requests, try again later', result.retryAfterSeconds);
    return new AcceptedResponse({ ...ACK }, { Headers: [NO_STORE] });
  }

  /**
   * Verify the address
   * Body `{ secret }`, the secret of the verification link. 200 `{ Ok: true }`; any refused secret, a missing one
   * included, 400 `invalid_secret` with one body. 429 with Retry-After while the client ip is throttled (the `reset` flow).
   * @security []
   */
  @Post('auth/verify')
  public async verify(@Req() req: Request) {
    const secret = secretField(req);
    if (secret === null) return invalidSecret();
    const result = await this.Passwords!.redeemVerification!(secret, contextOf(req, 'request'));
    if (result.status === 'throttled') return tooManyRequests('too many verification attempts, try again later', result.retryAfterSeconds);
    return result.status === 'verified' ? new Ok({ ...ACK }, { Headers: [NO_STORE] }) : invalidSecret();
  }
}
