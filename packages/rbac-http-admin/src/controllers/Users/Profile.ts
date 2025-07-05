import { AutoinjectService } from '@spinajs/configuration';
import { BaseController, BasePath, Get, Ok, Param, Policy } from '@spinajs/http';
import { _user, UserProfileProvider } from '@spinajs/rbac';
import { AuthorizedPolicy, Permission, Resource } from "@spinajs/rbac-http";


@BasePath('users/profile')
@Policy(AuthorizedPolicy)
@Resource('users')
export class Roles extends BaseController {


    @AutoinjectService('user.profile')
    protected ProfileService: UserProfileProvider;

    @Get(':login')
    @Permission(['readAny'])
    public async getUserProfile(@Param() login: string) {
         return new Ok(this.ProfileService.retrieve(login));
    }
}
