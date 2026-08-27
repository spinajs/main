import { Autoinject } from '@spinajs/di';
import { AutoinjectService } from '@spinajs/configuration';
import { BaseController, BasePath, Body, Del, Get, Ok, Param, Patch, Policy, Post, Query } from '@spinajs/http';
import { InvalidArgument, ResourceDuplicated, ResourceNotFound } from '@spinajs/exceptions';
import { SortOrder, SqlOperator } from '@spinajs/orm';
import { Filter, FilterableOperators, FromModel, IColumnFilter, IFilterRequest, OrderDTO, PaginationDTO } from '@spinajs/orm-http';
import { create, deleteUser, PasswordProvider, User, USER_SECURITY_METADATA_KEYS, _user_update, userModel } from '@spinajs/rbac';
import { AuthorizedPolicy, Permission, Resource, User as CurrentUser } from '@spinajs/rbac-http';
import { Schema } from '@spinajs/validation';

import { RoleGuard } from '../../interfaces.js';

// Side effect only: registers DefaultRoleGuard under the RoleGuard base so
// `rbac.admin.roleGuard.service` has something to resolve to. The type import
// above is erased at compile time, and controllers are loaded by path rather
// than through the package index, so without this the guard is missing in
// exactly the deployments that never import the package themselves.
import '../../services/RoleGuard.js';

/**
 * Columns a client may sort by.
 *
 * `OrderDTO.column` is a free-form string and reaches the query builder as an
 * identifier. The compiler escapes it, so this is not an injection hole — but an
 * unknown column produced a driver error and a 500 where the request was simply
 * wrong. Whitelisting turns that into a 400 and keeps the sortable surface a
 * deliberate decision rather than "whatever columns the table happens to have".
 */
const SORTABLE_COLUMNS = ['Uuid', 'Login', 'Email', 'Role', 'IsActive', 'CreatedAt', 'LastLoginAt', 'DeletedAt'];

/**
 * Upper bound on `pagination.limit`. An admin list endpoint with no ceiling is
 * a table dump one query string away.
 */
const MAX_PAGE_SIZE = 100;

const DEFAULT_PAGE_SIZE = 10;

@Schema({
  type: 'object',
  $id: 'arrow.common.createUserDto',
  properties: {
    Login: { type: 'string', minLength: 3, maxLength: 32, description: 'Unique login name (3–32 characters)' },
    Email: { type: 'string', format: 'email', description: 'Unique email address' },
    Role: { type: 'string', minLength: 1, maxLength: 32, description: 'RBAC role to assign to the user' },
    Metadata: {
      type: 'object',
      $id: 'arrow.common.userMetadata',
      additionalProperties: true,
      description: 'Optional key-value metadata to attach to the user account',
    },
  },
  required: ['Login', 'Email', 'Role'],
})
export class CreateUserDto {
  public Login: string;
  public Email: string;
  public Role: string;

  public Metadata?: { [key: string]: any };

  constructor(data: Partial<CreateUserDto>) {
    Object.assign(this, data);
  }
}

/**
 * PATCH body. Separate from {@link CreateUserDto} because the two have opposite
 * requirements: creation needs all three fields, an update needs none of them.
 * Sharing one schema made every documented partial update fail validation with
 * a 400 before the handler ever ran.
 *
 * Metadata is deliberately absent — it is managed through the dedicated
 * `/user/:uuid/metadata` routes, which validate one entry at a time and can
 * refuse the keys that decide account access.
 */
@Schema({
  type: 'object',
  $id: 'arrow.common.updateUserDto',
  properties: {
    Login: { type: 'string', minLength: 3, maxLength: 32, description: 'Unique login name (3–32 characters)' },
    Email: { type: 'string', format: 'email', description: 'Unique email address' },
    Role: { type: 'string', minLength: 1, maxLength: 32, description: 'RBAC role to assign to the user' },
  },
  additionalProperties: false,
})
export class UpdateUserDto {
  public Login?: string;
  public Email?: string;
  public Role?: string;

  constructor(data: Partial<UpdateUserDto>) {
    Object.assign(this, data);
  }
}

/**
 * User model filter
 * We declare it here to not include orm-http in rbac module
 * and add unnessesery dependency
 */
const USER_FILTER: IColumnFilter<User>[] = [
  {
    column: 'Uuid',
    operators: ['eq'],
  },
  {
    column: 'Email',
    operators: ['eq', 'like'],
  },
  {
    column: 'Login',
    operators: ['eq', 'like'],
  },
  {
    column: 'CreatedAt',
    operators: ['eq', 'gte', 'lte', 'lt', 'gt'],
  },
  {
    column: 'LastLoginAt',
    operators: ['eq', 'gte', 'lte', 'lt', 'gt'],
  },
  {
    column: 'DeletedAt',
    operators: ['eq', 'gte', 'lte', 'lt', 'gt', 'isnull', 'notnull'],
  },
  {
    column: 'IsActive',
    operators: ['eq'],
  },
  {
    column: 'Role',
    operators: ['eq', 'neq'],
  },
  {
    column: 'user:niceName',
    operators: ['eq', 'neq', 'like', 'b-like', 'e-like'],
    query: (operator: FilterableOperators, value: any) => {
      return function () {
        this.whereExist('Metadata', function () {
          this.where('Key', 'user:niceName');

          // NOTE: `operator` is the filter operator coming from the request
          // ( eq / neq / like ... ), NOT an SQL one. It has to be translated
          // before it reaches the query builder, which only understands SQL
          // operators and would throw `operator eq is invalid` otherwise.
          switch (operator) {
            case 'eq':
              this.where('Value', SqlOperator.EQ, value);
              break;
            case 'neq':
              this.where('Value', SqlOperator.NOT, value);
              break;
            case 'like':
              this.where('Value', SqlOperator.LIKE, `%${value}%`);
              break;
            case 'b-like':
              this.where('Value', SqlOperator.LIKE, `%${value}`);
              break;
            case 'e-like':
              this.where('Value', SqlOperator.LIKE, `${value}%`);
              break;
          }
        });
      };
    },
  },
];

/**
 * User account management (admin).
 * Full CRUD operations for user accounts. Supports pagination, sorting, filtering,
 * and optional relation loading. All write operations require full authorization.
 * @tags Admin Users
 */
@BasePath('users')
@Policy(AuthorizedPolicy)
@Resource('users')
export class Users extends BaseController {
  @Autoinject()
  protected PasswordProvider: PasswordProvider;

  @AutoinjectService('rbac.admin.roleGuard')
  protected RoleGuard: RoleGuard;

  /**
   * List users (admin)
   * Returns a paginated, sortable, filterable list of all users. Supports optional inclusion
   * of related Metadata. The total user count (matching current filters) is returned in the
   * X-Total-Count response header.
   * Filterable fields: Uuid (eq), Email (eq, like), Login (eq, like), CreatedAt, LastLoginAt,
   * DeletedAt (eq, gte, lte, lt, gt, isnull, notnull), IsActive (eq), Role (eq, neq),
   * user:niceName metadata (eq, neq, like).
   * @security cookieAuth
   * @param pagination.page Page number (zero-based)
   * @param pagination.limit Number of users per page (default: 10, max: 100)
   * @param order.column Column to sort by (default: CreatedAt). One of Uuid, Login, Email, Role, IsActive, CreatedAt, LastLoginAt, DeletedAt
   * @param order.order Sort direction: ASC or DESC (default: DESC)
   * @param include Relations to include — currently supports: Metadata
   * @returns {User[]} Paginated list of user accounts, each with optional Metadata relation
   * @response 400 Sort column is not sortable
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — readAny permission required on users resource
   */
  @Get('/')
  @Permission(['readAny', 'readOwn'])
  public async list(
    @Query() pagination?: PaginationDTO,
    @Query() order?: OrderDTO,
    @Query({
      type: 'array',
      items: {
        type: 'string',
        enum: ['Metadata'],
      },
    })
    include?: string[],
    @Filter(USER_FILTER)
    filter?: IFilterRequest,
  ) {
    // ONE limit for both take and skip. They used to disagree — take fell back
    // to 10 while skip fell back to 0 — so any request that sent a page but no
    // limit silently got page 0 whatever it asked for.
    const limit = Math.min(pagination?.limit || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const column = this.sortColumn(order);

    const result = await userModel()
      .select()
      .leftJoin(
        'Metadata',
        function () {
          // TODO: allow to inject custom meta props that need to be selected
          // eg. user:niceName, user:avatar etc.
          // this is used for filtering / sorting by custom meta props
          this.where('Key', 'user:niceName');
        },
        function () {
          this.select('Value', 'user:niceName');
        },
      )
      .populate(include ?? [])
      .take(limit)
      .skip(limit * (pagination?.page ?? 0))
      .order(column, order?.order ?? SortOrder.DESC)
      .filter(filter?.filters ?? [], filter?.op, USER_FILTER);

    const count = await userModel()
      .query()
      .filter(filter?.filters ?? [], filter?.op, USER_FILTER)
      .selectCount();

    return new Ok(
      result.map((x) =>
        x.dehydrateWithRelations({
          dateTimeFormat: 'iso',
        }),
      ),
      {
        Headers: [
          {
            Name: 'X-Total-Count',
            Value: count,
          },
        ],
      },
    );
  }

  /**
   * List assignable roles (admin)
   * Returns the roles the calling administrator is allowed to grant, as decided by the
   * configured role guard — the system role and anything granting more than the caller
   * holds are left out, so a UI cannot offer an operation the guard will refuse.
   * @security cookieAuth
   * @returns {string[]} Role names the caller may assign
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — readAny permission required on users resource
   */
  @Get('roles')
  @Permission(['readAny', 'readOwn'])
  public async assignableRoles(@CurrentUser() actor: User) {
    return new Ok(this.RoleGuard.assignableRoles(actor));
  }

  /**
   * Get user by UUID (admin)
   * Retrieves a single user record by UUID. Supports optional inclusion of related Metadata.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @param include Relations to include — currently supports: Metadata
   * @returns {User} User account with optional Metadata relation
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — readAny permission required on users resource
   * @response 404 User not found
   */
  @Get(':user')
  @Permission(['readAny', 'readOwn'])
  public async getSingleUser(
    @FromModel({ queryField: 'Uuid', model: () => userModel() }) user: User,
    @Query({
      type: 'array',
      items: {
        type: 'string',
        enum: ['Metadata'],
      },
    })
    include?: string[],
  ) {
    // linter hack, to alow incldue param,it is used by FromModel qery arg
    include;
    return new Ok(user.dehydrateWithRelations({ dateTimeFormat: 'iso' }));
  }

  /**
   * Get user by login (admin)
   * Retrieves a single user record by login name. Supports optional inclusion of related Metadata.
   * @security cookieAuth
   * @param user User login name path parameter
   * @param include Relations to include — currently supports: Metadata
   * @returns {User} User account with optional Metadata relation
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — readAny permission required on users resource
   * @response 404 User not found
   */
  @Get('byLogin/:user')
  @Permission(['readAny', 'readOwn'])
  public async getByLogin(
    @FromModel({ queryField: 'Login', model: () => userModel() }) user: User,
    @Query({
      type: 'array',
      items: {
        type: 'string',
        enum: ['Metadata'],
      },
    })
    include?: string[],
  ) {
    // linter hack, to alow incldue param,it is used by FromModel qery arg
    include;
    return new Ok(user.dehydrateWithRelations({ dateTimeFormat: 'iso' }));
  }

  /**
   * Create user (admin)
   * Creates a new user account with a system-generated temporary password. The account is
   * created inactive and the temporary password is never returned — issue a reset link with
   * `POST /users/security/password-reset-request/:user` and activate the account once the
   * user has set their own password.
   * @security cookieAuth
   * @returns {User} Created user account
   * @response 400 Validation error — missing required fields, invalid format, unknown role or a protected metadata key
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — createAny permission required, or the requested role grants more than the caller holds
   * @response 409 Login or email already in use
   */
  @Post('/')
  @Permission(['createAny', 'createOwn'])
  public async addUser(@CurrentUser() actor: User, @Body() data: CreateUserDto) {
    await this.RoleGuard.assertCanAssignRoles(actor, null, [data.Role]);
    this.assertNoProtectedMetadata(data.Metadata);
    await this.assertUnique(data.Login, data.Email);

    const temporaryPassword = this.PasswordProvider.generate();
    const { User: created } = await create(data.Email, data.Login, temporaryPassword, [data.Role], undefined, data.Metadata);

    // NOTE: create() returns { User, Password } where Password is the plaintext
    // temporary password. It must NOT be sent in the response — return only the
    // created user (dehydrated, so the hash and internal id stay hidden too).
    return new Ok(created.dehydrateWithRelations({ dateTimeFormat: 'iso' }));
  }

  /**
   * Update user (admin)
   * Partially updates a user account. All fields are optional — only provided fields are changed.
   * Metadata is NOT handled here; use the `/user/:uuid/metadata` routes.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @response 200 User updated successfully
   * @response 400 Validation error — invalid field format or unknown role
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny permission required, or the role change is refused by the role guard
   * @response 404 User not found
   * @response 409 Login or email already in use by another account
   */
  @Patch(':user')
  @Permission(['updateAny', 'updateOwn'])
  public async updateUser(@CurrentUser() actor: User, @FromModel({ queryField: 'Uuid', include: ['Metadata'], model: () => userModel() }) user: User, @Body() data: UpdateUserDto) {
    if (data.Role) {
      const next = [data.Role];
      const added = next.filter((r) => !user.Role.includes(r));
      const removed = user.Role.filter((r) => !next.includes(r));

      // A role list REPLACEMENT is a grant and a revoke at the same time, and
      // both halves have their own rules — dropping the caller's last privileged
      // role through PATCH must fail exactly as `revoke` does.
      await this.RoleGuard.assertCanAssignRoles(actor, user, added);

      for (const role of removed) {
        await this.RoleGuard.assertCanRevokeRole(actor, user, role);
      }
    }

    if ((data.Login && data.Login !== user.Login) || (data.Email && data.Email !== user.Email)) {
      await this.assertUnique(data.Login !== user.Login ? data.Login : undefined, data.Email !== user.Email ? data.Email : undefined, user.Id);
    }

    user.Login = data.Login ?? user.Login;
    user.Email = data.Email ?? user.Email;
    user.Role = data.Role ? [data.Role] : user.Role;

    await user.update();

    return new Ok();
  }

  /**
   * Delete user (admin)
   * Soft-deletes the account (`DeletedAt` is stamped, the row is kept) and destroys every
   * session it holds, so a deleted user stops acting immediately rather than when their
   * cookie happens to expire.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @response 200 User deleted
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — deleteAny permission required, or the deletion is refused by the role guard
   * @response 404 User not found
   */
  @Del(':user')
  @Permission(['deleteAny', 'deleteOwn'])
  public async removeUser(@CurrentUser() actor: User, @FromModel({ queryField: 'Uuid', include: ['Metadata'], model: () => userModel() }) user: User) {
    await this.RoleGuard.assertCanDisableAccount(actor, user, 'delete');
    await deleteUser(user);

    return new Ok();
  }

  /**
   * Restore a deleted user (admin)
   * Clears `DeletedAt` on a soft-deleted account. The account keeps its previous
   * `IsActive` state — restoring is not activating.
   * @security cookieAuth
   * @param uuid User UUID path parameter
   * @response 200 User restored
   * @response 400 User is not deleted
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — deleteAny permission required on users resource
   * @response 404 User not found
   */
  @Patch(':uuid/restore')
  @Permission(['deleteAny', 'deleteOwn'])
  public async restoreUser(@Param() uuid: string) {
    // Loaded by hand rather than through @FromModel: every model query filters
    // soft-deleted rows out by default, so the one row this route exists for is
    // exactly the row @FromModel can never find.
    const user = await userModel().query().withDeleted().where('Uuid', uuid).first();

    if (!user) {
      throw new ResourceNotFound(`User ${uuid} not found`);
    }

    if (!user.DeletedAt) {
      throw new InvalidArgument(`User ${uuid} is not deleted`);
    }

    await _user_update({ DeletedAt: null as any })(user);

    return new Ok();
  }

  /**
   * The requested sort column, or the default. Rejects anything outside
   * {@link SORTABLE_COLUMNS}.
   */
  protected sortColumn(order?: OrderDTO): string {
    const column = order?.column;

    if (!column) {
      return 'CreatedAt';
    }

    if (!SORTABLE_COLUMNS.includes(column)) {
      throw new InvalidArgument(`Cannot sort by '${column}'. Sortable columns are: ${SORTABLE_COLUMNS.join(', ')}`);
    }

    return column;
  }

  /**
   * Refuses metadata keys that decide account access.
   *
   * `user:pwd_reset:token` is a bearer credential for the public reset endpoint
   * and `user:2fa:*` is the second factor itself — writing either through a
   * generic key-value merge hands out an account rather than annotating one.
   * Ban and lockout keys are refused for the same reason bans have their own
   * route: written directly they skip the event, the email and the session
   * revocation that make a ban mean something.
   */
  protected assertNoProtectedMetadata(metadata?: { [key: string]: any }): void {
    if (!metadata) {
      return;
    }

    const offending = Object.keys(metadata).filter((key) => {
      // A glob reaches the metadata relation's setter as a PATTERN and rewrites
      // every matching entry, so `*` alone would overwrite the whole set —
      // including the protected keys listed above.
      if (key.includes('*') || key.includes('?')) {
        return true;
      }

      return USER_SECURITY_METADATA_KEYS.includes(key);
    });

    if (offending.length > 0) {
      throw new InvalidArgument(`Metadata keys cannot be set through this endpoint: ${offending.join(', ')}`);
    }
  }

  /**
   * Rejects a login / email already taken by another account.
   *
   * Soft-deleted rows are included on purpose: they still occupy the unique
   * indexes, so ignoring them would trade this 409 for a driver error and a 500.
   *
   * The 409 carries WHICH field clashed, not only that something did. The error
   * body is built by spreading the thrown exception's own enumerable properties
   * (`__handle_error__`, @spinajs/http), so `parameter` reaches the client
   * alongside `message` in the shape {@link ValidationFailed} already uses for
   * schema rejections — an AJV-style entry per offending field. A form can then
   * mark the Email input rather than showing "something is already in use"
   * somewhere off to the side.
   *
   * Attached to a plain {@link ResourceDuplicated} rather than a subclass on
   * purpose: `__handle_error__` looks the response up by `err.constructor.name`,
   * so a subclass would miss the 409 mapping entirely and answer 500.
   */
  // base User on purpose: uniqueness is global — a scoped model would hide the
  // clashing row and turn this 409 into a driver 500
  protected async assertUnique(login?: string, email?: string, exceptUserId?: number): Promise<void> {
    const clashes: string[] = [];

    if (login) {
      const found = await User.query().withDeleted().where('Login', login).first();
      if (found && found.Id !== exceptUserId) {
        clashes.push('Login');
      }
    }

    if (email) {
      const found = await User.query().withDeleted().where('Email', email).first();
      if (found && found.Id !== exceptUserId) {
        clashes.push('Email');
      }
    }

    if (clashes.length > 0) {
      const error = new ResourceDuplicated(`${clashes.join(' and ')} already in use`);

      Object.assign(error, {
        parameter: clashes.map((field) => ({
          // JSON Pointer into the request body, exactly as ajv reports one — a
          // client maps it to its own field name with the same code path it
          // already uses for a 400.
          instancePath: `/${field}`,
          keyword: 'duplicate',
          params: { field },
          message: `${field} already in use`,
        })),
      });

      throw error;
    }
  }
}
