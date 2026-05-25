import { TokenDto } from './../dto/token-dto.js';
import { BaseController, BasePath, Ok, Post, Get, ForbiddenResponse } from '@spinajs/http';
import { ISession, SessionProvider, User as UserModel, _user_ev, _user_update, _unwindGrants, AccessControl } from '@spinajs/rbac';
import { Session } from "@spinajs/rbac-http";
import { Body, Policy } from '@spinajs/http';
import _ from 'lodash';
import { TwoFacRouteEnabled } from '../policies/2FaPolicy.js';
import { AutoinjectService, _service } from '@spinajs/configuration';
import { Autoinject } from '@spinajs/di';
import { QueueService } from '@spinajs/queue';
import { _chain, _check_arg, _non_empty, _non_null, _tap, _trim, _use } from '@spinajs/util';
import { User, NotAuthorizedPolicy, IEnable2faResponse, IUserWithGrants } from "@spinajs/rbac-http";
import { auth2Fa, disableUser2Fa } from "./../actions/2fa.js";
import { enableUser2Fa } from "../actions/2fa.js";
import { InvalidOperation } from '@spinajs/exceptions';

/**
 * Two-factor authentication (TOTP) management.
 * Enables, disables, and verifies TOTP-based two-factor authentication for users.
 * All routes are only available when 2FA is enabled in the system configuration.
 * The caller must be logged in but does NOT need to be fully authorized (2FA verified),
 * allowing these routes to be used during the 2FA verification step itself.
 * @tags Two-Factor Authentication
 */
@BasePath('auth')
@Policy(TwoFacRouteEnabled)
@Policy(NotAuthorizedPolicy)
export class TwoFactorAuthController extends BaseController {
    @Autoinject(QueueService)
    protected Queue: QueueService;

    @AutoinjectService('rbac.session')
    protected SessionProvider: SessionProvider;

    @Autoinject(AccessControl)
    protected AC: AccessControl;

    /**
     * Enable two-factor authentication
     * Generates a TOTP secret for the authenticated user and returns the OTP provisioning URI
     * to be scanned by an authenticator app. Throws if 2FA is already enabled for the user.
     * @security cookieAuth
     * @returns {IEnable2faResponse} OTP provisioning URI to scan with an authenticator app
     * @response 400 Two-factor authentication is already enabled for this user
     * @response 401 Unauthorized — valid session required
     */
    @Get('2fa/enable')
    public async enable2fa(@User() user: UserModel): Promise<Ok<IEnable2faResponse>> {

        if (user.Metadata['2fa:enabled']) {
            throw new InvalidOperation(`User ${user.Uuid} already has 2fa enabled`);
        }

        const result = await enableUser2Fa(user);
        return new Ok({
            otp: result as string
        });
    }

    /**
     * Disable two-factor authentication
     * Removes the TOTP secret and disables 2FA for the authenticated user.
     * Throws if 2FA is not currently enabled for the user.
     * @security cookieAuth
     * @response 200 Two-factor authentication disabled successfully
     * @response 400 Two-factor authentication is not enabled for this user
     * @response 401 Unauthorized — valid session required
     */
    @Get('2fa/disable')
    public async disable2Fa(@User() user: UserModel) {
        if (!user.Metadata['2fa:enabled']) {
            throw new InvalidOperation(`User ${user.Uuid} already has 2fa disabled`);
        }

        await disableUser2Fa(user);
        return new Ok();
    }

    /**
     * Verify TOTP token
     * Validates the provided TOTP token against the user's 2FA secret. On success, marks the session
     * as fully authorized and returns the user profile with RBAC grants — identical to a full login response.
     * @security cookieAuth
     * @returns {IUserWithGrants} User profile merged with RBAC grants on successful 2FA verification
     * @response 403 Invalid or expired TOTP token
     * @response 401 Unauthorized — valid session required
     */
    @Post('2fa/verify')
    public async verifyToken(@User() logged: UserModel, @Body() token: TokenDto, @Session() session: ISession): Promise<Ok<IUserWithGrants> | ForbiddenResponse> {

        try {
            await auth2Fa(logged, token.Token);

            // 2fa complete, mark as authorized
            // fron now on user is considered authorized
            session.Data.set('Authorized', true);
            session.Data.delete('TwoFactorAuth');
            await this.SessionProvider.save(session);

            this._log.trace('User logged in, 2fa authorized', {
                Uuid: logged.Uuid
            });


            const grants = this.AC.getGrants();
            const userGrants = logged.Role.map(r => _unwindGrants(r, grants));
            const combinedGrants = Object.assign({}, ...userGrants);


            return new Ok({
                ...logged.dehydrateWithRelations({
                    dateTimeFormat: "iso"
                }),
                Grants: combinedGrants,
            } as unknown as IUserWithGrants);
        }
        catch (err) {

            if (err instanceof Error) {
                this._log.error(err, "2fa verification failed");
            } else {
                this._log.error("2fa verification failed", { error: err });
            }

            return new ForbiddenResponse({
                error: {
                    code: 'E_2FA_FAILED',
                    message: '2fa check failed',
                },
            });
        }
    }
}
