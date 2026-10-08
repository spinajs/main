import { Post, BasePath, Ok, Del, Body, Get, Query, Param, BaseController, Patch, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import type { User } from '@spinajs/users';
import { Autoinject } from '@spinajs/di';
import { Access } from '@spinajs/authz-http';
import { PaginationDTO, OrderDTO, Filter } from '@spinajs/orm-http';
import type { IFilterRequest } from '@spinajs/orm-http';

import { CurrentUser } from '../args/current-user.js';
import { UserMetadataDto } from '../dto/metadata-dto.js';
import { FilterableUserMetadata } from '../models/FilterableUserMetadata.js';
import { UserMetadataService } from '../services/UserMetadataService.js';
import { addressedMetadata, ownMetadata } from '../services/metadata-scope.js';

/**
 * User metadata management.
 * Provides CRUD operations for key-value metadata entries attached to user accounts.
 * Routes under `/user/:user/metadata` address a user by UUID; routes under `/user/metadata` the
 * signed-in user. Every route sits on `@Access('user.metadata:<action>')`.
 *
 * Both families delegate to {@link UserMetadataService}, which limits every query to the addressed
 * user, decides each row for the caller, and hides reserved security keys on every route. A grant
 * that holds only on some rows (users' `user` role: `owner`) reaches the caller's own metadata in
 * either family and no other user's; another user's metadata needs an unconditional grant.
 * @tags User Metadata
 */
@BasePath('user')
export class UserMetadataController extends BaseController {

    @Autoinject(UserMetadataService)
    protected Metadata: UserMetadataService;

    /**
     * List metadata for a specific user
     * Returns a paginated, filtered, and ordered list of metadata entries for the given user.
     * @security cookieAuth
     * @param user User UUID path parameter
     * @param pagination.page Page number (zero-based)
     * @param pagination.limit Number of entries per page
     * @param order.column Column to sort by (default: Id)
     * @param order.order Sort direction: ASC or DESC (default: DESC)
     * @returns {IUserMetadataEntry[]} Paginated list of metadata entries for the user
     * @response 401 Unauthorized — no signed-in principal
     * @response 403 Forbidden — no `user.metadata:read`, or only a conditional one on another user
     * @response 404 User not found
     */
    @Get(":user/metadata")
    @Access('user.metadata:read')
    public async readUserMeta(
        @Req() req: Request,
        @Param() user: string,
        @Query() pagination?: PaginationDTO,
        @Query() order?: OrderDTO,
        @Filter(FilterableUserMetadata)
        filter?: IFilterRequest,
    ) {
        return new Ok(await this.Metadata.list(await addressedMetadata(req, user), pagination, order, filter));
    }


    /**
     * Get a single metadata entry for a specific user
     * Retrieves one metadata entry by key for the given user.
     * @security cookieAuth
     * @param user User UUID path parameter
     * @param key Metadata key to retrieve
     * @returns {IUserMetadataEntry} Single metadata entry for the user
     * @response 401 Unauthorized — no signed-in principal
     * @response 403 Forbidden — no `user.metadata:read` on the entry
     * @response 404 User or metadata key not found, or the key is reserved
     */
    @Get(":user/metadata/:key")
    @Access('user.metadata:read')
    public async getUserMeta(
        @Req() req: Request,
        @Param() user: string,
        @Param() key: string) {
        return new Ok(await this.Metadata.getByKey(await addressedMetadata(req, user), key));
    }

    /**
     * Add or update metadata for a specific user
     * Inserts a new metadata entry for the given user, or updates it if the key already exists.
     * @security cookieAuth
     * @param user User UUID path parameter
     * @response 200 Metadata created or updated successfully
     * @response 400 The key is reserved
     * @response 401 Unauthorized — no signed-in principal
     * @response 403 Forbidden — no `user.metadata:create` on the entry, or no `user.metadata:update` on the entry it overwrites
     * @response 404 User not found
     */
    @Post(":user/metadata")
    @Access('user.metadata:create')
    public async addUserMetadata(
        @Req() req: Request,
        @Param() user: string,
        @Body() data: UserMetadataDto) {

        await this.Metadata.upsert(await addressedMetadata(req, user), data);
        return new Ok();
    }

    /**
     * Update a metadata entry for a specific user
     * Updates Key, Value, and Type of an existing metadata entry identified by Id or Key.
     * @security cookieAuth
     * @param user User UUID path parameter
     * @param meta Metadata Id or Key to update

     * @response 200 Metadata updated successfully
     * @response 400 The new key is reserved
     * @response 401 Unauthorized — no signed-in principal
     * @response 403 Forbidden — no `user.metadata:update` on the entry
     * @response 404 User or metadata entry not found, or its key is reserved
     */
    @Patch(':user/metadata/:meta')
    @Access('user.metadata:update')
    public async updateUserMetadata(
        @Req() req: Request,
        @Param() user: string,
        // A plain param, not @FromModel: the service answers a missing and a reserved entry with
        // the same 404; a model lookup here would fail differently and tell the two apart.
        @Param() meta: string,
        @Body() data: UserMetadataDto) {

        await this.Metadata.update(await addressedMetadata(req, user), meta, data);

        return new Ok();
    }

    /**
     * Delete a metadata entry for a specific user
     * Permanently removes a metadata entry by Id from the given user's metadata.
     * @security cookieAuth
     * @param user User UUID path parameter
     * @param meta Metadata Id to delete
     * @response 200 Metadata deleted successfully
     * @response 401 Unauthorized — no signed-in principal
     * @response 403 Forbidden — no `user.metadata:delete` on the entry
     * @response 404 User or metadata entry not found, or its key is reserved
     */
    @Del(':user/metadata/:meta')
    @Access('user.metadata:delete')
    public async deleteUserMetadata(
        @Req() req: Request,
        @Param() user: string,
        @Param() meta: number) {
        await this.Metadata.delete(await addressedMetadata(req, user), meta);

        return new Ok();
    }

    /**
     * List own metadata
     * Returns a paginated, filtered, and ordered list of metadata entries for the signed-in user.
     * @security cookieAuth
     * @param pagination.page Page number (zero-based)
     * @param pagination.limit Number of entries per page
     * @param order.column Column to sort by (default: Id)
     * @param order.order Sort direction: ASC or DESC (default: DESC)
     * @returns {IUserMetadataEntry[]} Paginated list of own metadata entries
     * @response 401 Unauthorized — no signed-in principal
     * @response 403 Forbidden — not a user principal, or no `user.metadata:read`
     */
    @Get("metadata")
    @Access('user.metadata:read')
    public async readMeta(
        @Req() req: Request,
        @CurrentUser() user: User,
        @Query() pagination?: PaginationDTO,
        @Query() order?: OrderDTO,
        @Filter(FilterableUserMetadata)
        filter?: IFilterRequest,
    ) {
        return new Ok(await this.Metadata.list(ownMetadata(req, user), pagination, order, filter));
    }

    /**
     * Get own metadata entry by key
     * Retrieves a single metadata entry by key for the signed-in user.
     * @security cookieAuth
     * @param key Metadata key to retrieve
     * @returns {IUserMetadataEntry} Single own metadata entry by key
     * @response 401 Unauthorized — no signed-in principal
     * @response 403 Forbidden — not a user principal, or no `user.metadata:read` on the entry
     * @response 404 Metadata key not found, or the key is reserved
     */
    @Get("metadata/:key")
    @Access('user.metadata:read')
    public async getMeta(@Req() req: Request, @CurrentUser() user: User, @Param() key: string) {
        return new Ok(await this.Metadata.getByKey(ownMetadata(req, user), key));
    }

    /**
     * Add or update own metadata
     * Inserts a new metadata entry for the signed-in user, or updates it if the key already exists.
     * @security cookieAuth
     * @response 200 Metadata created or updated successfully
     * @response 400 The key is reserved
     * @response 401 Unauthorized — no signed-in principal
     * @response 403 Forbidden — not a user principal, or no `user.metadata:create` (and `update` for an existing key)
     */
    @Post("metadata")
    @Access('user.metadata:create')
    public async addMetadata(@Req() req: Request, @CurrentUser() user: User, @Body() data: UserMetadataDto) {
        await this.Metadata.upsert(ownMetadata(req, user), data);
        return new Ok();
    }

    /**
     * Update own metadata entry
     * Updates Key, Value, and Type of an existing metadata entry identified by Id or Key.
     * @security cookieAuth
     * @param meta Metadata Id or Key to update

     * @response 200 Metadata updated successfully
     * @response 400 The new key is reserved
     * @response 401 Unauthorized — no signed-in principal
     * @response 403 Forbidden — not a user principal, or no `user.metadata:update` on the entry
     * @response 404 Metadata entry not found, or its key is reserved
     */
    @Patch('metadata/:meta')
    @Access('user.metadata:update')
    public async updateMetadata(@Req() req: Request, @CurrentUser() user: User, @Param() meta: string, @Body() data: UserMetadataDto) {
        await this.Metadata.update(ownMetadata(req, user), meta, data);

        return new Ok();
    }

    /**
     * Delete own metadata entry
     * Permanently removes a metadata entry by Id from the signed-in user's metadata.
     * @security cookieAuth
     * @param meta Metadata Id to delete
     * @response 200 Metadata deleted successfully
     * @response 401 Unauthorized — no signed-in principal
     * @response 403 Forbidden — not a user principal, or no `user.metadata:delete` on the entry
     * @response 404 Metadata entry not found, or its key is reserved
     */
    @Del('metadata/:meta')
    @Access('user.metadata:delete')
    public async deleteMetadata(@Req() req: Request, @CurrentUser() user: User, @Param() meta: number) {
        await this.Metadata.delete(ownMetadata(req, user), meta);

        return new Ok();
    }
}
