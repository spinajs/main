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


@BasePath('users/security')
@Policy(AuthorizedPolicy)
@Resource('users')
export class Security extends BaseController {

    @Autoinject(SessionProvider)
    protected SessionProvider: SessionProvider;

    @Patch('changePassword/:user')
    @Permission(['updateAny'])
    public async changeUserPassword(@FromModel({ queryField: "Uuid" }) user: User, @Body() dto: ChangePasswordDto) {
        await changePassword(dto.password)(user);
        return new Ok();
    }

    @Patch('reset2fa/:user')
    @Permission(['updateAny'])
    public async reset2faToken(@FromModel({ queryField: "Uuid" }) user: User) {
        await resetUser2Fa(user);
        return new Ok();
    }

    @Get('deactivate/:user')
    @Permission(['deleteAny'])
    public async deactivateUser(@FromModel({ queryField: "Uuid" }) user: User) {
        await deactivate(user);
        return new Ok();
    }

    @Get('activate/:user')
    @Permission(['deleteAny'])
    public async activateUser(@FromModel({ queryField: "Uuid" }) user: User) {
        await activate(user);
        return new Ok();
    }

    @Get('logout/:user')
    @Permission(['updateAny'])
    public async logoutUser(@FromModel({ queryField: "Uuid" }) user: User) {
        await this.SessionProvider.logsOut(user);
        return new Ok();
    }
}
