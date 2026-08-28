import { User, getUserUnsafe, updateUser, UserLoginFailed, assertNotLocked, clearLoginThrottle, registerFailedLogin } from '@spinajs/rbac';
import { ev } from '@spinajs/queue';
import { Unauthorized } from '@spinajs/http';
import { service } from '@spinajs/configuration';
import { DateTime } from 'luxon';
import { _check_arg, _non_empty, _trim } from '@spinajs/util';
import { User2FaPassed } from '../events/User2FaPassed.js';
import { User2FaEnabled } from '../events/User2FaEnabled.js';
import { TwoFactorAuthProvider } from '@spinajs/rbac-http';
import { User2FaReset } from '../events/User2FaReset.js';
import { User2FaDisabled } from '../events/User2FaDisabled.js';

/**
 * Initializes 2fa for a user and switches it on.
 *
 * The event is emitted for the USER, while the action resolves with whatever
 * the provider call returned ( `initialize()` returns the otpauth url ).
 */
export async function enableUser2Fa(identifier: number | string | User) {
  const u = await getUserUnsafe(identifier);
  const twoFa = await service('rbac.twoFactorAuth', TwoFactorAuthProvider);

  const result = await twoFa.initialize(u);
  await ev(new User2FaEnabled(u));

  return result;
}

/**
 * Hand the user a secret without switching 2fa on. No event is emitted: an
 * enrolment nobody confirmed is not a fact about the account, and consumers
 * listening for User2FaEnabled would otherwise fire on an abandoned attempt.
 */
export async function beginUser2FaEnrolment(identifier: number | string | User) {
  const u = await getUserUnsafe(identifier);
  const twoFa = await service('rbac.twoFactorAuth', TwoFactorAuthProvider);

  return twoFa.beginEnrolment(u);
}

/**
 * Switch 2fa on for an account whose code was already verified by the caller.
 * The login-window flow needs this split: `auth2Fa` has already checked the
 * code and emitted User2FaPassed by the time the session is authorized.
 */
export async function activateUser2Fa(identifier: number | string | User) {
  const u = await getUserUnsafe(identifier);
  const twoFa = await service('rbac.twoFactorAuth', TwoFactorAuthProvider);

  await twoFa.activate(u);
  await ev(new User2FaEnabled(u));

  return u;
}

/**
 * Complete an enrolment started by `beginUser2FaEnrolment`: verify the code
 * against the stored secret, then switch 2fa on. Throws Unauthorized when the
 * code does not match, leaving the enrolment pending so the user can retry.
 */
export async function confirmUser2Fa(identifier: number | string | User, token: string) {
  token = _check_arg(_trim(), _non_empty())(token, 'token');

  const u = await getUserUnsafe(identifier);
  const twoFa = await service('rbac.twoFactorAuth', TwoFactorAuthProvider);

  if (!(await twoFa.verifyToken(token, u))) {
    throw new Unauthorized('2fa confirmation failed');
  }

  // Delegates to `activateUser2Fa`, which re-resolves the provider itself. It
  // is shared with the login-window flow, where the code is already verified
  // by the time activation is needed.
  return activateUser2Fa(u);
}

export async function disableUser2Fa(identifier: number | string | User) {
  const u = await getUserUnsafe(identifier);
  const twoFa = await service('rbac.twoFactorAuth', TwoFactorAuthProvider);

  await twoFa.disable(u);
  await ev(new User2FaDisabled(u));

  return u;
}

export async function resetUser2Fa(identifier: number | string | User) {
  const u = await getUserUnsafe(identifier);
  const twoFa = await service('rbac.twoFactorAuth', TwoFactorAuthProvider);

  await twoFa.disable(u);
  await ev(new User2FaReset(u));

  return u;
}

/**
 * Verify 2fa token for user.
 *
 * On success `LastLoginAt` is stamped and a {@link User2FaPassed} event is
 * emitted. On failure a {@link UserLoginFailed} event is emitted and the
 * original error is re-thrown.
 *
 * @param identifier - numeric id, uuid / email / login string, or an existing {@link User}
 * @param token - 2fa code to verify
 */
export async function auth2Fa(identifier: number | string | User, token: string) {
  token = _check_arg(_trim(), _non_empty())(token, 'token');

  // A lookup failure is not a failed 2fa attempt - there is no account to
  // report it against.
  const u = await getUserUnsafe(identifier);

  try {
    // A 6-digit code is brute-forceable; failed 2fa attempts count into the
    // SAME lockout the password throttle uses, and a locked account refuses
    // before the code is even checked.
    assertNotLocked(u);

    const twoFa = await service('rbac.twoFactorAuth', TwoFactorAuthProvider);

    if (!(await twoFa.verifyToken(token, u))) {
      throw new Unauthorized('2fa check failed');
    }

    await updateUser(u, { LastLoginAt: DateTime.now() });
    await clearLoginThrottle(u);
    await ev(new User2FaPassed(u));

    return u;
  } catch (err) {
    await registerFailedLogin(u, err);
    await ev(new UserLoginFailed(u, err));
    throw err;
  }
}
