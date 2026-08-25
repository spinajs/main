import { Post, BasePath, Ok, Del, Body, Get, Query, Param, Policy, BaseController, Patch } from '@spinajs/http';
import { User as UserModel, UserMetadata } from '@spinajs/rbac';
import { Autoinject } from '@spinajs/di';
import { AuthorizedPolicy, Permission, Resource, User } from '@spinajs/rbac-http';
import { PaginationDTO, OrderDTO, Filter, IFilterRequest, FromModel } from '@spinajs/orm-http';
import { UserMetadataDto } from '../dto/metadata-dto.js';
import { FilterableUserMetadata } from '../models/FilterableUserMetadata.js';
import { addressedColumn, UserMetadataService } from '../services/UserMetadataService.js';

/**
 * User metadata management.
 * Provides CRUD operations for key-value metadata entries attached to user accounts.
 * Admin routes operate on any user (identified by UUID), while own routes operate on the
 * currently authenticated user's metadata.
 *
 * Both families delegate to {@link UserMetadataService}, which owns the owner
 * scoping — the only thing that ever differed between them is where the owner
 * id comes from.
 * @tags User Metadata
 */
@BasePath('user')
@Resource('user.metadata')
@Policy(AuthorizedPolicy)
export class UserMetadataController extends BaseController {

    @Autoinject(UserMetadataService)
    protected Metadata: UserMetadataService;

    /**
     * List metadata for a specific user (admin)
     * Returns a paginated, filtered, and ordered list of metadata entries for the given user.
     * @security cookieAuth
     * @param user User UUID path parameter
     * @param pagination.page Page number (zero-based)
     * @param pagination.limit Number of entries per page
     * @param order.column Column to sort by (default: Id)
     * @param order.order Sort direction: ASC or DESC (default: DESC)
     * @returns {IUserMetadataEntry[]} Paginated list of metadata entries for the user
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
        return new Ok(this.Metadata.list(user.Id, pagination, order, filter));
    }


    /**
     * Get a single metadata entry for a specific user (admin)
     * Retrieves one metadata entry by key for the given user.
     * @security cookieAuth
     * @param user User UUID path parameter
     * @param key Metadata key to retrieve
     * @returns {IUserMetadataEntry} Single metadata entry for the user
     * @response 401 Unauthorized — valid session required
     * @response 403 Forbidden — readAny permission required
     * @response 404 User or metadata key not found
     */
    @Get(":user/metadata/:key")
    @Permission(['readAny'])
    public async getUserMeta(
        @FromModel({ queryField: "Uuid" }) user: UserModel,
        @Param() key: string) {
        return new Ok(this.Metadata.getByKey(user.Id, key));
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
        @Body() data: UserMetadataDto) {

        await this.Metadata.upsert(user.Id, data);
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
            // ONE column, picked by the identifier's shape — see `addressedColumn`. Comparing both
            // in an `OR` put a numeric id against the `Key` varchar, which MySQL then refused in
            // the UPDATE this lookup feeds (`ER_TRUNCATED_WRONG_VALUE`), turning every
            // id-addressed edit into a 500.
            query: (function ([_, user], meta) {
                return this.where(addressedColumn(meta), meta).andWhere("user_id", user.Id)
            })
        }) meta: UserMetadata,
        @FromModel({ queryField: "Uuid" }) _user: UserModel,
        @Body() data: UserMetadataDto) {

        // @FromModel already resolved the entry within the addressed user's
        // scope ( so a miss is a 404 ); the write still goes through the
        // owner-scoped service so the predicate is not restated here.
        await this.Metadata.update(_user.Id, meta.Id, data);

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
        await this.Metadata.delete(user.Id, meta);

        return new Ok();
    }

    /**
     * List own metadata
     * Returns a paginated, filtered, and ordered list of metadata entries for the authenticated user.
     * @security cookieAuth
     * @param pagination.page Page number (zero-based)
     * @param pagination.limit Number of entries per page
     * @param order.column Column to sort by (default: Id)
     * @param order.order Sort direction: ASC or DESC (default: DESC)
     * @returns {IUserMetadataEntry[]} Paginated list of own metadata entries
     * @response 401 Unauthorized — valid session required
     * @response 403 Forbidden — readOwn permission required
     */
    @Get("metadata")
    @Permission(['readOwn'])
    public async readMeta(
        @User() user: UserModel,
        @Query() pagination?: PaginationDTO,
        @Query() order?: OrderDTO,
        @Filter(FilterableUserMetadata)
        filter?: IFilterRequest,
    ) {
        return new Ok(this.Metadata.list(user.Id, pagination, order, filter));
    }

    /**
     * Get own metadata entry by key
     * Retrieves a single metadata entry by key for the authenticated user.
     * @security cookieAuth
     * @param key Metadata key to retrieve
     * @returns {IUserMetadataEntry} Single own metadata entry by key
     * @response 401 Unauthorized — valid session required
     * @response 403 Forbidden — readOwn permission required
     * @response 404 Metadata key not found
     */
    @Get("metadata/:key")
    @Permission(['readOwn'])
    public async getMeta(@User() user: UserModel, @Param() key: string) {
        return new Ok(this.Metadata.getByKey(user.Id, key));
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
    public async addMetadata(@User() user: UserModel, @Body() data: UserMetadataDto) {
        await this.Metadata.upsert(user.Id, data);
        return new Ok();
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
    public async updateMetadata(@User() user: UserModel, @Param() meta: string, @Body() data: UserMetadataDto) {
        await this.Metadata.update(user.Id, meta, data);

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
    public async deleteMetadata(@User() user: UserModel, @Param() meta: number) {
        await this.Metadata.delete(user.Id, meta);

        return new Ok();
    }
}
