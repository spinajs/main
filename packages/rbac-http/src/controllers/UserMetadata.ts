import { Patch, Post, BasePath, Ok, Forbidden } from '@spinajs/http';
import { User as UserModel, UserMetadata } from '@spinajs/rbac';
import { Resource } from './../decorators';
import { Permission, User } from '../decorators';
import { FromModel, AsModel } from '@spinajs/orm-http';

@BasePath('user/:user/metadata')
@Resource('user.metadata')
export class UserMetaController {
  @Post()
  @Permission('updateOwn')
  public async addMetadata(@User() logged: UserModel, @FromModel() user: UserModel, @AsModel() meta: UserMetadata) {
    if (logged.Id !== user.Id) {
      throw new Forbidden('cannot add metadata to another user');
    }

    await user.Metadata.add(meta);
    return new Ok(meta);
  }

  @Patch('user/:user/metadata/:meta')
  @Permission('updateOwn')
  public async updateMetadata(@User() logged: UserModel, @FromModel() user: UserModel, @FromModel() meta: UserMetadata) {
    if (logged.Id !== user.Id) {
      throw new Forbidden('cannot add metadata to another user');
    }

    await meta.User.populate();
    if (meta.User.Value.Id !== logged.Id) {
      throw new Forbidden('cannot edit metadata that is not own by user');
    }

    await meta.update();

    return new Ok();
  }
}

// function userOwnerPermissionStrategy(){

//    // 1. obtain current logged user
//    // 2. find

// }
