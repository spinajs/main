import { Forbidden } from './../../../http/src/response-methods/forbidden';
import { Body, Param, Patch, Post, BasePath, Ok } from '@spinajs/http';
import { User as UserModel, UserMetadata } from '@spinajs/rbac';
import { Resource } from 'rbac-http/lib';
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

    return new Ok();
  }
}
