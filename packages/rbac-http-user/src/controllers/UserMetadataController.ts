import { Post, BasePath, Ok, Del, Body, Get, Query, Param, Policy, BaseController, Patch } from '@spinajs/http';
import { User as UserModel, UserMetadata } from '@spinajs/rbac';
import { LoggedPolicy, Permission, Resource } from '@spinajs/rbac-http';
import { AsModel, PaginationDTO, OrderDTO, Filter, IFilter, FromModel } from '@spinajs/orm-http';
import { UserMetadataDto } from '../dto/metadata-dto.js';
import { InsertBehaviour, SortOrder } from '@spinajs/orm';
import { FilterableUserMetadata } from '../models/FilterableUserMetadata.js';

@BasePath('user')
@Resource('user.metadata')
@Policy(LoggedPolicy)
export class UserMetadataController extends BaseController {


    /**
     *  SPECIFIC USER FUNCTIONS ( ADMIN FUNCTIONS )
     */

    @Get(":user/metadata")
    @Permission(['readAny'])
    public async readUserMeta(
        @FromModel({ queryField: "Uuid" }) user: UserModel,
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


    @Get(":user/metadata/:key")
    @Permission(['readAny'])
    public async getUserMeta(
        @FromModel({ queryField: "Uuid" }) user: UserModel,
        @Param() key: string) {
        return new Ok(UserMetadata.where({
            Key: key,
            user_id: user.Id
        }).firstOrFail());
    }

    @Post(":user/metadata")
    @Permission(['updateAny'])
    public async addUserMetadata(
        @FromModel({ queryField: "Uuid" }) user: UserModel,
        @AsModel() metadata: UserMetadata) {

        metadata.User.attach(user);
        await metadata.insert(InsertBehaviour.InsertOrUpdate);
        return new Ok();
    }

    @Patch(':_user/metadata/:meta')
    @Permission(['updateAny'])
    public async updateUserMetadata(
        @FromModel({
            query: (function ([_, user], meta) {
                return this.where(function () {
                    this.where("Key", meta).orWhere("Id", meta)
                }).andWhere("user_id", user.Id)
            })
        }) meta: UserMetadata,
        @FromModel({ queryField: "Uuid" }) _user: UserModel,
        @Body() data: UserMetadataDto) {
        await meta.update({
            Key: data.Key,
            Value: data.Value,
            Type: data.Type
        })

        return new Ok();
    }

    @Del(':user/metadata/:meta')
    @Permission(['deleteAny'])
    public async deleteUserMetadata(
        @FromModel({ queryField: "Uuid" }) user: UserModel,
        @Param() meta: number) {
        await UserMetadata.destroy().where({
            Id: meta,
            user_id: user.Id
        });

        return new Ok();
    }



    /**
     * --------------------------------------------------------------------------
     */



    @Get("metadata")
    @Permission(['readOwn'])
    public async readMeta(
        @Query() pagination?: PaginationDTO,
        @Query() order?: OrderDTO,
        @Filter(FilterableUserMetadata)
        filter?: IFilter[],
    ) {
        return new Ok(FilterableUserMetadata.select().filter(filter)
            .take(pagination?.limit ?? undefined)
            .skip(pagination?.limit * pagination?.page || 0)
            .order(order?.column ?? 'Id', order?.order ?? SortOrder.DESC)
        );
    }

    @Get("metadata/:key")
    @Permission(['readOwn'])
    public async getMeta(@Param() key: string) {
        return new Ok(UserMetadata.where({
            Key: key,
        }).firstOrFail());
    }

    @Post("metadata")
    @Permission(['updateOwn'])
    public async addMetadata(@AsModel() metadata: UserMetadata) {
        await metadata.insert(InsertBehaviour.InsertOrUpdate);
    }

    @Patch('metadata/:meta')
    @Permission(['updateOwn'])
    public async updateMetadata(@Param() meta: string, @Body() data: UserMetadataDto) {
        await UserMetadata.update({
            Key: data.Key,
            Value: data.Value,
            Type: data.Type
        }).where("Key", meta).orWhere("Id", meta);

        return new Ok();
    }

    @Del('metadata/:meta')
    @Permission(['deleteOwn'])
    public async deleteMetadata(@Param() meta: number) {
        await UserMetadata.destroy().where({
            Id: meta
        });

        return new Ok();
    }
}
