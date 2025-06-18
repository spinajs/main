import { User, _user_ev, _user_unsafe, _user_update } from '@spinajs/rbac';
import _ from 'lodash';
import { _service } from '@spinajs/configuration';
import { DateTime } from 'luxon';
import { _chain, _check_arg, _non_empty, _non_null, _map, _trim, _use, _catch } from '@spinajs/util';
import { User2FaPassed } from '../events/User2FaPassed.js';
import { TwoFactorAuthProvider } from '@spinajs/rbac-http';
import { UserLoginFailed } from '@spinajs/rbac';


/**
 * 
 * Verify 2fa token for user
 * 
 * @param user 
 * @param token 
 * @returns 
 */
export async function auth2Fa(identifier: number | string | User, token: string) {
    token = _check_arg(_trim(), _non_empty)(token, 'token');

    return _chain(
        _user_unsafe(identifier),
        _catch(
            (u: User) => {
                return _chain(_service('rbac.twoFactorAuth', TwoFactorAuthProvider), async (twoFa: TwoFactorAuthProvider) => twoFa.verifyToken(token, u), _user_update({ LastLoginAt: DateTime.now() }), _user_ev(User2FaPassed));
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
