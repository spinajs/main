import { BaseController, BasePath, Body, Get, Ok, Patch, Policy } from '@spinajs/http';
import { FromModel } from '@spinajs/orm-http';
import { _user, activate, changePassword, deactivate, SessionProvider, User } from '@spinajs/rbac';
import { AuthorizedPolicy, Permission, Resource } from "@spinajs/rbac-http";
import { Schema } from '@spinajs/validation';
import { resetUser2Fa } from '@spinajs/rbac-http-user';
import { Autoinject } from '@spinajs/di';

@Schema({
    type: 'object',
    $id: 'arrow.common.changePasswordDTO',
    properties: {
        password: { type: 'string', minLength: 8, maxLength: 128 },
        confirmPassword: { type: 'string', minLength: 8, maxLength: 128 }
    },
    required: ['password', 'confirmPassword'],
    allOf: [
        {
            if: {
                properties: {
                    password: { type: 'string' },
                    confirmPassword: { type: 'string' }
                }
            },
            then: {
                properties: {
                    confirmPassword: { const: { $data: '1/password' } }
                }
            }
        }
    ]
})
class ChangePasswordDto {
    public password: string;
    public confirmPassword: string;

    constructor(data: any) {
        Object.assign(this, data);
    }
}


/**
 * User account security management (admin).
 * Administrative controls for user account security: password changes, 2FA reset,
 * account activation/deactivation, and forced session logout.
 * @tags Admin Users
 */
@BasePath('users/security')
@Policy(AuthorizedPolicy)
@Resource('users')
export class Security extends BaseController {

    @Autoinject(SessionProvider)
    protected SessionProvider: SessionProvider;

    /**
     * Change user password (admin)
     * Sets a new password for the specified user. Both password and confirmPassword must match.
     * Minimum length is 8 characters.
     * @security cookieAuth
     * @param user User UUID path parameter
     * @param dto.password New password (min 8, max 128 characters)
     * @param dto.confirmPassword Must match password
     * @response 200 Password changed successfully
     * @response 400 Passwords do not match or fail validation
     * @response 401 Unauthorized — valid session required
     * @response 403 Forbidden — updateAny permission required on users resource
     * @response 404 User not found
     */
    @Patch('changePassword/:user')
    @Permission(['updateAny'])
    public async changeUserPassword(@FromModel({ queryField: "Uuid" }) user: User, @Body() dto: ChangePasswordDto) {
        await changePassword(dto.password)(user);
        return new Ok();
    }

    /**
     * Reset user two-factor authentication (admin)
     * Clears the TOTP secret and disables 2FA for the specified user.
     * Use this to help a user regain access when they lose their authenticator device.
     * @security cookieAuth
     * @param user User UUID path parameter
     * @response 200 2FA reset successfully
     * @response 401 Unauthorized — valid session required
     * @response 403 Forbidden — updateAny permission required on users resource
     * @response 404 User not found
     */
    @Patch('reset2fa/:user')
    @Permission(['updateAny'])
    public async reset2faToken(@FromModel({ queryField: "Uuid" }) user: User) {
        await resetUser2Fa(user);
        return new Ok();
    }

    /**
     * Deactivate user account (admin)
     * Marks the user account as inactive, preventing login without deleting the record.
     * @security cookieAuth
     * @param user User UUID path parameter
     * @response 200 Account deactivated successfully
     * @response 401 Unauthorized — valid session required
     * @response 403 Forbidden — deleteAny permission required on users resource
     * @response 404 User not found
     */
    @Get('deactivate/:user')
    @Permission(['deleteAny'])
    public async deactivateUser(@FromModel({ queryField: "Uuid" }) user: User) {
        await deactivate(user);
        return new Ok();
    }

    /**
     * Activate user account (admin)
     * Marks a previously deactivated user account as active, restoring login access.
     * @security cookieAuth
     * @param user User UUID path parameter
     * @response 200 Account activated successfully
     * @response 401 Unauthorized — valid session required
     * @response 403 Forbidden — deleteAny permission required on users resource
     * @response 404 User not found
     */
    @Get('activate/:user')
    @Permission(['deleteAny'])
    public async activateUser(@FromModel({ queryField: "Uuid" }) user: User) {
        await activate(user);
        return new Ok();
    }

    /**
     * Force logout user (admin)
     * Invalidates all active sessions for the specified user, immediately ending any current logins.
     * @security cookieAuth
     * @param user User UUID path parameter
     * @response 200 All sessions invalidated successfully
     * @response 401 Unauthorized — valid session required
     * @response 403 Forbidden — updateAny permission required on users resource
     * @response 404 User not found
     */
    @Get('logout/:user')
    @Permission(['updateAny'])
    public async logoutUser(@FromModel({ queryField: "Uuid" }) user: User) {
        await this.SessionProvider.logsOut(user);
        return new Ok();
    }
}
