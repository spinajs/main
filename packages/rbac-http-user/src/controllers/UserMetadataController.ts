import { Post, BasePath, Ok, Del, Body, Get, Query, Param, Policy, BaseController, Patch } from '@spinajs/http';
import { User as UserModel, UserMetadata } from '@spinajs/rbac';
import { AuthorizedPolicy, Permission, Resource } from '@spinajs/rbac-http';
import { AsModel, PaginationDTO, OrderDTO, Filter, IFilterRequest, FromModel } from '@spinajs/orm-http';
import { UserMetadataDto } from '../dto/metadata-dto.js';
import { InsertBehaviour, SortOrder } from '@spinajs/orm';
import { FilterableUserMetadata } from '../models/FilterableUserMetadata.js';

/**
 * User metadata management.
 * Provides CRUD operations for key-value metadata entries attached to user accounts.
 * Admin routes operate on any user (identified by UUID), while own routes operate on the
 * currently authenticated user's metadata.
 * @tags User Metadata
 */
@BasePath('user')
@Resource('user.metadata')
@Policy(AuthorizedPolicy)
export class UserMetadataController extends BaseController {

    /**
     * List metadata for a specific user (admin)
     * Returns a paginated, filtered, and ordered list of metadata entries for the given user.
     * @security cookieAuth
     * @param user User UUID path parameter
     * @param pagination.page Page number (zero-based)
     * @param pagination.limit Number of entries per page
     * @param order.column Column to sort by (default: Id)
     * @param order.order Sort direction: ASC or DESC (default: DESC)
     * @returns {array} Array of UserMetadata entries: { Id, Key, Value, Type, user_id }
     * @response 401 Unauthorized — valid session required
     * @response 403 Forbidden — readAny permission required
     * @response 404 User not found
     */
    @Get(":user/metadata")
    @Permission(['readAny'])
    public async readUserMeta(
        @FromModel({ queryField: "Uuid" }) user: UserModel,
        @Query() pagination?: PaginationDTO,
        @Query() order?: OrderDTO,
        @Filter(FilterableUserMetadata)
        filter?: IFilterRequest,
    ) {
        return new Ok(FilterableUserMetadata.select().where({
            user_id: user.Id
        }).filter(filter?.filters, filter?.op)
            .take(pagination?.limit ?? undefined)
            .skip(pagination?.limit * pagination?.page || 0)
            .order(order?.column ?? 'Id', order?.order ?? SortOrder.DESC)
        );
    }


    /**
     * Get a single metadata entry for a specific user (admin)
     * Retrieves one metadata entry by key for the given user.
     * @security cookieAuth
     * @param user User UUID path parameter
     * @param key Metadata key to retrieve
     * @returns {object} UserMetadata entry: { Id, Key, Value, Type, user_id }
     * @response 401 Unauthorized — valid session required
     * @response 403 Forbidden — readAny permission required
     * @response 404 User or metadata key not found
     */
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

    /**
     * Add or update metadata for a specific user (admin)
     * Inserts a new metadata entry for the given user, or updates it if the key already exists.
     * @security cookieAuth
     * @param user User UUID path parameter
     * @response 200 Metadata created or updated successfully
     * @response 401 Unauthorized — valid session required
     * @response 403 Forbidden — updateAny permission required
     * @response 404 User not found
     */
    @Post(":user/metadata")
    @Permission(['updateAny'])
    public async addUserMetadata(
        @FromModel({ queryField: "Uuid" }) user: UserModel,
        @AsModel() metadata: UserMetadata) {

        metadata.User.attach(user);
        await metadata.insert(InsertBehaviour.InsertOrUpdate);
        return new Ok();
    }

    /**
     * Update a metadata entry for a specific user (admin)
     * Updates Key, Value, and Type of an existing metadata entry identified by Id or Key.
     * @security cookieAuth
     * @param _user User UUID path parameter (used for authorization scope)
     * @param meta Metadata Id or Key to update

     * @response 200 Metadata updated successfully
     * @response 401 Unauthorized — valid session required
     * @response 403 Forbidden — updateAny permission required
     * @response 404 User or metadata entry not found
     */
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

    /**
     * Delete a metadata entry for a specific user (admin)
     * Permanently removes a metadata entry by Id from the given user's metadata.
     * @security cookieAuth
     * @param user User UUID path parameter
     * @param meta Metadata Id to delete
     * @response 200 Metadata deleted successfully
     * @response 401 Unauthorized — valid session required
     * @response 403 Forbidden — deleteAny permission required
     * @response 404 User or metadata entry not found
     */
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



    /**
     * List own metadata
     * Returns a paginated, filtered, and ordered list of metadata entries for the authenticated user.
     * @security cookieAuth
     * @param pagination.page Page number (zero-based)
     * @param pagination.limit Number of entries per page
     * @param order.column Column to sort by (default: Id)
     * @param order.order Sort direction: ASC or DESC (default: DESC)
     * @returns {array} Array of UserMetadata entries: { Id, Key, Value, Type }
     * @response 401 Unauthorized — valid session required
     * @response 403 Forbidden — readOwn permission required
     */
    @Get("metadata")
    @Permission(['readOwn'])
    public async readMeta(
        @Query() pagination?: PaginationDTO,
        @Query() order?: OrderDTO,
        @Filter(FilterableUserMetadata)
        filter?: IFilterRequest,
    ) {
        return new Ok(FilterableUserMetadata.select().filter(filter?.filters, filter?.op)
            .take(pagination?.limit ?? undefined)
            .skip(pagination?.limit * pagination?.page || 0)
            .order(order?.column ?? 'Id', order?.order ?? SortOrder.DESC)
        );
    }

    /**
     * Get own metadata entry by key
     * Retrieves a single metadata entry by key for the authenticated user.
     * @security cookieAuth
     * @param key Metadata key to retrieve
     * @returns {object} UserMetadata entry: { Id, Key, Value, Type }
     * @response 401 Unauthorized — valid session required
     * @response 403 Forbidden — readOwn permission required
     * @response 404 Metadata key not found
     */
    @Get("metadata/:key")
    @Permission(['readOwn'])
    public async getMeta(@Param() key: string) {
        return new Ok(UserMetadata.where({
            Key: key,
        }).firstOrFail());
    }

    /**
     * Add or update own metadata
     * Inserts a new metadata entry for the authenticated user, or updates it if the key already exists.
     * @security cookieAuth
     * @response 200 Metadata created or updated successfully
     * @response 401 Unauthorized — valid session required
     * @response 403 Forbidden — updateOwn permission required
     */
    @Post("metadata")
    @Permission(['updateOwn'])
    public async addMetadata(@AsModel() metadata: UserMetadata) {
        await metadata.insert(InsertBehaviour.InsertOrUpdate);
    }

    /**
     * Update own metadata entry
     * Updates Key, Value, and Type of an existing metadata entry identified by Id or Key.
     * @security cookieAuth
     * @param meta Metadata Id or Key to update

     * @response 200 Metadata updated successfully
     * @response 401 Unauthorized — valid session required
     * @response 403 Forbidden — updateOwn permission required
     * @response 404 Metadata entry not found
     */
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

    /**
     * Delete own metadata entry
     * Permanently removes a metadata entry by Id from the authenticated user's metadata.
     * @security cookieAuth
     * @param meta Metadata Id to delete
     * @response 200 Metadata deleted successfully
     * @response 401 Unauthorized — valid session required
     * @response 403 Forbidden — deleteOwn permission required
     * @response 404 Metadata entry not found
     */
    @Del('metadata/:meta')
    @Permission(['deleteOwn'])
    public async deleteMetadata(@Param() meta: number) {
        await UserMetadata.destroy().where({
            Id: meta
        });

        return new Ok();
    }
}
