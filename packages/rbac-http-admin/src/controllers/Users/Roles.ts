import { BaseController, BasePath, Body, Ok, Param, Patch, Policy } from '@spinajs/http';
import { _user, grant, revoke } from '@spinajs/rbac';
import { AuthorizedPolicy, Permission, Resource } from "@spinajs/rbac-http";
import { Schema } from '@spinajs/validation';


@Schema({
    type: 'object',
    $id: 'arrow.common.roleDTO',
    properties: {
        role: { type: 'string', minimum: 0, maximum: 32 },
    },
})
export class RoleDto {
    public role: string;

    constructor(data: Partial<RoleDto>) {
        Object.assign(this, data);
    }
}


@BasePath('users/role')
@Policy(AuthorizedPolicy)
@Resource('users')
export class Roles extends BaseController {
    @Patch('add/:login')
    @Permission(['updateAny'])
    public async addRole(@Param() login: string, @Body() roleDto: RoleDto) {
        await grant(login, roleDto.role);
        return new Ok()
    }
    
    @Patch('revoke/:login')
    @Permission(['updateAny'])
    public async revokeRole(@Param() login: string, @Body() roleDto: RoleDto) {
        await revoke(login, roleDto.role);
        return new Ok()
    }
}
