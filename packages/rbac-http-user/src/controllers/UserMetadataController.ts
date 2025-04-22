import { Post, BasePath, Ok, Del, Body, Get, Query, Param, Policy, BaseController, Patch } from '@spinajs/http';
import { User as UserModel, UserMetadata } from '@spinajs/rbac';
import { LoggedPolicy, Permission, Resource, User } from '@spinajs/rbac-http';
import { AsModel, PaginationDTO, OrderDTO, Filter, IFilter } from '@spinajs/orm-http';
import { Forbidden } from '@spinajs/exceptions';
import { UserMetadataDto } from '../dto/metadata-dto.js';
import { SortOrder } from '@spinajs/orm';
import { FilterableUserMetadata } from '../models/FilterableUserMetadata.js';

@BasePath('user/metadata')
@Resource('user.metadata')
@Policy(LoggedPolicy)
export class UserMetadataController extends BaseController {

    @Get("/")
    @Permission(['readOwn', 'readAny'])
    public async readMeta(
        @User() user: UserModel,
        @Query() pagination?: PaginationDTO,
        @Query() order?: OrderDTO,
        @Filter(FilterableUserMetadata)
        filter?: IFilter[],
    ) {
        return new Ok(FilterableUserMetadata.select().where({
            user_id: user.Id
        }).filter(filter)
            .take(pagination?.limit ?? undefined)
            .skip(pagination?.limit * pagination?.page || 0)
            .order(order?.column ?? 'Id', order?.order ?? SortOrder.DESC)
        );
    }

    @Get(":key")
    public async getMeta(@User() user: UserModel, @Param() key: string) {
        return new Ok(UserMetadata.where({
            Key: key,
            user_id: user.Id
        }).firstOrFail());
    }

    @Post("/")
    @Permission(['updateOwn', 'updateAny'])
    public async addMetadata(@User() user: UserModel, @AsModel() metadata: UserMetadata) {

        metadata.User.attach(user);
        await metadata.insert();

        return new Ok(metadata);
    }

    @Patch(':meta')
    @Permission(['updateOwn', 'updateAny'])
    public async updateMetadata(@User() user: UserModel, @Param() meta: string, @Body() data: UserMetadataDto) {

        const metadata = await UserMetadata.where("Key", meta).orWhere("Id", meta).firstOrFail();

        if (metadata.user_id !== user.Id) {
            throw new Forbidden(`cannot update metadata for given user`);
        }

        metadata.Key = data.Key;
        metadata.Value = data.Value;
        metadata.Type = data.Type;
        await metadata.update();

        return new Ok();
    }

    @Del(':meta')
    @Permission(['deleteOwn', 'deleteAny'])
    public async deleteMetadata(@User() user: UserModel, @Param() meta: number) {
        const m = await UserMetadata.where({
            Id: meta,
            user_id: user.Id
        }).firstOrFail();

        await m.destroy();
        return new Ok();
    }
}
