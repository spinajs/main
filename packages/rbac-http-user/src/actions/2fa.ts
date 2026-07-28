import { User, _user_ev, _user_unsafe, _user_update, UserLoginFailed } from '@spinajs/rbac';
import { Unauthorized } from "@spinajs/http";
import _ from 'lodash';
import { _service } from '@spinajs/configuration';
import { DateTime } from 'luxon';
import { _chain, _check_arg, _non_empty, _non_null, _map, _trim, _use, _catch, _either, _tap } from '@spinajs/util';
import { User2FaPassed } from '../events/User2FaPassed.js';
import { User2FaEnabled } from '../events/User2FaEnabled.js';
import { TwoFactorAuthProvider, } from '@spinajs/rbac-http';
import { User2FaReset } from '../events/User2FaReset.js';
import { User2FaDisabled } from '../events/User2FaDisabled.js';


/**
 * NOTE for all three actions below: the event must be emitted for the USER, not
 * for whatever the provider call returned ( `initialize()` returns the otpauth
 * url ). `_user_ev` reads `Uuid` off its argument, so it is bound to `u`
 * explicitly and the provider result is passed through untouched.
 */

export async function enableUser2Fa(identifier: number | string | User) {
    return _chain(
        _user_unsafe(identifier),
        (u: User) => {
            return _chain(
                _service('rbac.twoFactorAuth', TwoFactorAuthProvider),
                async (twoFa: TwoFactorAuthProvider) => twoFa.initialize(u),
                // keeps the otpauth url as the result of the action
                _tap(async () => _user_ev(User2FaEnabled)(u)),
            );
        },
    );
}

export async function disableUser2Fa(identifier: number | string | User) {
    return _chain(
        _user_unsafe(identifier),
        (u: User) => {
            return _chain(
                _service('rbac.twoFactorAuth', TwoFactorAuthProvider),
                async (twoFa: TwoFactorAuthProvider) => twoFa.disable(u),
                () => _user_ev(User2FaDisabled)(u),
            );
        },
    );
}

export async function resetUser2Fa(identifier: number | string | User) {
    return _chain(
        _user_unsafe(identifier),
        (u: User) => {
            // NOTE: this used to read
            //   return _chain( ... ), _tap(_user_ev(User2FaReset));
            // The comma operator threw the disabling chain away un-awaited and
            // returned the _tap function itself, so `await resetUser2Fa(user)`
            // resolved before ( or without ) the secrets being cleared and the
            // User2FaReset event was never emitted.
            return _chain(
                _service('rbac.twoFactorAuth', TwoFactorAuthProvider),
                async (twoFa: TwoFactorAuthProvider) => twoFa.disable(u),
                () => _user_ev(User2FaReset)(u),
            );
        },
    );
}

/**
 * 
 * Verify 2fa token for user
 * 
 * @param user 
 * @param token 
 * @returns 
 */
export async function auth2Fa(identifier: number | string | User, token: string) {
    token = _check_arg(_trim(), _non_empty())(token, 'token');

    return _chain(
        _user_unsafe(identifier),
        _catch(
            (u: User) => {
                return _chain(_service('rbac.twoFactorAuth', TwoFactorAuthProvider), _either(
                    (twoFa: TwoFactorAuthProvider) => twoFa.verifyToken(token, u),
                    () => _chain(u, _user_update({ LastLoginAt: DateTime.now() }), _user_ev(User2FaPassed)),
                    () => {
                        throw new Unauthorized('2fa check failed');
                    }
                ))
            },
            (err, u: User) => {
                return _chain(
                    () => u,

                    // send event of failed login
                    _user_ev(UserLoginFailed, err),

                    // rethrow error for caller
                    () => {
                        throw err;
                    },
                );
            },
        ),
    );
}
