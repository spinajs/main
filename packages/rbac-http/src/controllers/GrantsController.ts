import { BaseController, BasePath, Get, Ok, Policy } from '@spinajs/http';
import { AccessControl } from '@spinajs/rbac';
import { Autoinject } from '@spinajs/di';
import { LoggedPolicy } from '../policies/LoggedPolicy.js';

@BasePath('grants')
@Policy(LoggedPolicy)
export class GrantsController extends BaseController {

    @Autoinject(AccessControl)
    protected AC: AccessControl;

    @Get()
    public getGrants() {
        return new Ok(this.AC.getGrants());
    }

}
