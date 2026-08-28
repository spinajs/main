import { BaseController, BasePath, Body, BadRequestResponse, Ok, Post } from '@spinajs/http';
import { confirmPasswordReset, passwordChangeRequest, RbacException } from '@spinajs/rbac';
import { InvalidArgument } from '@spinajs/exceptions';
import { SkipModelPermission } from '@spinajs/rbac-http';
import { PasswordResetConfirmDto, PasswordResetRequestDto } from '../dto/password-reset-dto.js';

/** Reply shared by both reset routes — deliberately says nothing about the account. */
export interface IPasswordResetAck {
  Ok: true;
}

/**
 * Password reset for users who cannot log in.
 *
 * Two public, unauthenticated steps: request a token, then redeem it. The token
 * itself is issued into the user's metadata by `passwordChangeRequest` and
 * delivered out of band (the `UserPasswordChangeRequest` event is what an app
 * hooks to send the mail) — it is never returned over HTTP, so possession of
 * the mailbox is what authorizes the reset.
 *
 * Neither route reveals whether an account exists. Both answer the same way for
 * a known and an unknown address, which is the whole point of a reset endpoint
 * that anybody may call: an attacker must not be able to farm valid addresses
 * from it, and a failed redemption must not distinguish "no such user" from
 * "wrong token".
 *
 * NOTE: these routes are unauthenticated and cheap to call in a loop. Put a
 * rate limit in front of them at the edge — this package does not provide one.
 *
 * @tags Authentication
 */
@BasePath('auth')
export class PasswordResetController extends BaseController {
  /**
   * Request a password reset
   * Issues a reset token for the account and emits `UserPasswordChangeRequest` so the
   * application can deliver it. Always succeeds, whether or not the address is known.
   * @security []
   * @returns {IPasswordResetAck} Acknowledgement — never indicates whether the account exists
   */
  @Post('password/reset-request')
  @SkipModelPermission()
  public async requestReset(@Body() payload: PasswordResetRequestDto): Promise<Ok<IPasswordResetAck>> {
    try {
      await this.issueToken(payload.Email);
    } catch (err) {
      // Swallowed on purpose. An unknown address, a deleted account or a
      // banned one must produce exactly the response a valid address does —
      // otherwise this route becomes an account enumeration oracle. Real
      // faults ( mail queue, database ) are logged for operators.
      this._log.warn(err as Error, `Password reset request could not be processed for ${payload.Email}`);
    }

    return new Ok({ Ok: true } as IPasswordResetAck);
  }

  /**
   * Complete a password reset
   * Redeems the token issued by `POST /auth/password/reset-request` and sets the new
   * password. The token is single-use and expires after `rbac.password.passwordResetWaitTime`.
   * @security []
   * @returns {IPasswordResetAck} Acknowledgement of a successful reset
   * @response 400 New passwords do not match, or the token is invalid or expired
   */
  @Post('password/reset')
  @SkipModelPermission()
  public async confirmReset(@Body() payload: PasswordResetConfirmDto): Promise<Ok<IPasswordResetAck> | BadRequestResponse> {
    if (payload.Password !== payload.ConfirmPassword) {
      throw new InvalidArgument('password does not match');
    }

    try {
      await this.redeemToken(payload.Email, payload.Password, payload.Token);
    } catch (err) {
      // One opaque failure for every rejection reason: unknown account, wrong
      // token, expired token. Distinguishing them would tell a caller which
      // addresses exist and let them probe tokens by the error they get back.
      const isRedemptionFailure = err instanceof RbacException || err instanceof InvalidArgument;

      if (!isRedemptionFailure) {
        this._log.error(err as Error, `Password reset failed unexpectedly for ${payload.Email}`);
        throw err;
      }

      this._log.warn(err as Error, `Password reset rejected for ${payload.Email}`);

      return new BadRequestResponse({
        error: {
          code: 'E_RESET_TOKEN_INVALID',
          message: 'Password reset token is invalid or has expired',
        },
      });
    }

    return new Ok({ Ok: true } as IPasswordResetAck);
  }

  /**
   * Issue a reset token into the user's metadata and emit
   * `UserPasswordChangeRequest`. Wraps the module-level action so tests can
   * stub it without a database.
   */
  protected issueToken(email: string): Promise<unknown> {
    return passwordChangeRequest(email);
  }

  /** Redeem a reset token. Wrapped for the same reason as {@link issueToken}. */
  protected redeemToken(email: string, password: string, token: string): Promise<unknown> {
    return confirmPasswordReset(email, password, token);
  }
}
