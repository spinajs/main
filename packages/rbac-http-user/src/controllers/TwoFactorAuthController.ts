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
import { User, NotAuthorizedPolicy, } from "@spinajs/rbac-http";
import { auth2Fa } from "./../actions/2fa.js";
import { enableUser2Fa } from "../actions/2fa.js";

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

    @Get('2fa/enable')
    public async enable2fa(@User() user: UserModel) {

        if (user.Metadata['2fa:enabled']) {
            return new Ok({
                otp: user.Metadata['2fa:otp'],
            });
        }

        const result = await enableUser2Fa(user);
        return new Ok({
            otp: result
        });
    }

    @Post('2fa/verify')
    public async verifyToken(@User() logged: UserModel, @Body() token: TokenDto, @Session() session: ISession) {

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
            });
        }
        catch (err) {
            this._log.error(err);

            return new ForbiddenResponse({
                error: {
                    code: 'E_2FA_FAILED',
                    message: '2fa check failed',
                },
            });
        }
    }
}
