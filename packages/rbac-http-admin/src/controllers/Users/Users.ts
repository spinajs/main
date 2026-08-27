import { AutoinjectService } from '@spinajs/configuration';
import { BaseController, BasePath, Body, Del, Get, Ok, Param, Patch, Policy, Post, Query } from '@spinajs/http';
import { ErrorCode, InvalidArgument, ResourceDuplicated, ResourceNotFound } from '@spinajs/exceptions';
import { SortOrder, SqlOperator } from '@spinajs/orm';
import { Filter, FilterableOperators, FromModel, IColumnFilter, IFilterRequest, OrderDTO, PaginationDTO } from '@spinajs/orm-http';
import { assertUserUnique, create, deleteUser, E_CODES, User, _user_update, userModel } from '@spinajs/rbac';
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

/**
 * Upper bound on how many roles one account may be given in a single request.
 * An account holds a handful of switchable profiles, not an unbounded list, and
 * every entry costs a guard check.
 */
const MAX_ROLES_PER_USER = 16;

/**
 * A single role name: no whitespace anywhere, so a "role" made only of blanks
 * cannot pass as one.
 *
 * `minLength` alone accepts `' '` and `['  ', '']` — every entry is a string of
 * allowed length — which reached `create()` as an empty role list and produced
 * an account nobody can use. The pattern refuses that here, in the schema, so
 * the caller gets a 400 naming the offending field instead of a handler-thrown
 * error with no field attached. Banning EDGE whitespace too keeps `uniqueItems`
 * honest: `'user'` and `' user '` would otherwise be two distinct entries
 * denoting one role, and the guard is charged per entry.
 */
const ROLE_NAME = {
  type: 'string',
  minLength: 1,
  maxLength: 32,
  pattern: '^\\S+$',
};

/**
 * The `Role` field of both DTOs: one role name, or a list of them.
 *
 * An account has always held a role LIST (`User.Role` is a set), and the roles
 * an application defines are typically switchable profiles a person may hold
 * several of at once. The single-string form is kept because it is what every
 * existing caller sends.
 *
 * `minItems` is what refuses `[]`. Stripping every role off an account is not
 * an update these routes perform: the account would keep existing while being
 * able to do nothing at all, and only another administrator could repair it.
 */
const ROLE_FIELD = {
  description: 'RBAC role to assign to the user, or a list of roles',
  oneOf: [
    ROLE_NAME,
    {
      type: 'array',
      items: ROLE_NAME,
      minItems: 1,
      maxItems: MAX_ROLES_PER_USER,
      uniqueItems: true,
    },
  ],
};

@Schema({
  type: 'object',
  $id: 'arrow.common.createUserDto',
  properties: {
    Login: { type: 'string', minLength: 3, maxLength: 32, description: 'Unique login name (3–32 characters)' },
    Email: { type: 'string', format: 'email', description: 'Unique email address' },
    Role: ROLE_FIELD,
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
  public Role: string | string[];

  public Metadata?: { [key: string]: any };

  constructor(data: Partial<CreateUserDto>) {
    Object.assign(this, data);
  }
}

/**
 * The roles a `Role` field denotes, whether it was sent as one name or a list.
 *
 * Shape normalisation only — every rejection lives in {@link ROLE_FIELD}. The
 * trim and the de-duplication are belt-and-braces for callers that reach the
 * handler without body validation ( tests, in-process calls ): the guard is
 * charged per entry, so a duplicate would be checked twice.
 */
function roleList(role?: string | string[]): string[] {
  if (role === undefined || role === null) {
    return [];
  }

  const wanted = (Array.isArray(role) ? role : [role]).map((r) => String(r ?? '').trim()).filter((r) => r.length > 0);

  return [...new Set(wanted)];
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
    Role: ROLE_FIELD,
  },
  additionalProperties: false,
})
export class UpdateUserDto {
  public Login?: string;
  public Email?: string;
  public Role?: string | string[];

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
   * created inactive and the temporary password is never returned: a single-use password-reset
   * link is mailed to the address instead, so the owner sets their own password and nothing
   * has to travel back through an administrator. Activate the account once they have.
   * `Role` takes one role name or a list of them; every entry is checked by the role guard, and
   * one refused entry refuses the whole request.
   * @security cookieAuth
   * @returns {User} Created user account
   * @response 400 Validation error — missing required fields, invalid format, an empty or unknown role, or a protected metadata key
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — createAny permission required, or a requested role grants more than the caller holds
   * @response 409 Login or email already in use, naming the clashing field in `parameter`
   */
  @Post('/')
  @Permission(['createAny', 'createOwn'])
  public async addUser(@CurrentUser() actor: User, @Body() data: CreateUserDto) {
    const roles = roleList(data.Role);

    await this.RoleGuard.assertCanAssignRoles(actor, null, roles);

    // No password: `create()` generates one AND mails the reset link that hands
    // the account to its owner. Both belong to the action, not to this route —
    // every other caller that creates an account needs them just as much, and
    // the uniqueness refusal comes from there now for the same reason.
    const { User: created } = await this.asDuplicateResponse(() => create(data.Email, data.Login, roles, { metadata: data.Metadata }));

    // NOTE: create() also returns the plaintext generated password. It must NOT
    // be sent in the response — return only the created user (dehydrated, so the
    // hash and internal id stay hidden too).
    return new Ok(created.dehydrateWithRelations({ dateTimeFormat: 'iso' }));
  }

  /**
   * Update user (admin)
   * Partially updates a user account. All fields are optional — only provided fields are changed.
   * Metadata is NOT handled here; use the `/user/:uuid/metadata` routes.
   * `Role` takes one role name or a list of them and REPLACES the account's whole role list, so
   * an entry left out is revoked and goes through the revoke half of the role guard. An empty
   * list is refused rather than applied.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @response 200 User updated successfully
   * @response 400 Validation error — invalid field format, an empty role list or an unknown role
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny permission required, or the role change is refused by the role guard
   * @response 409 Login or email already in use by another account, naming the clashing field in `parameter`
   * @response 404 User not found
   */
  @Patch(':user')
  @Permission(['updateAny', 'updateOwn'])
  public async updateUser(@CurrentUser() actor: User, @FromModel({ queryField: 'Uuid', include: ['Metadata'], model: () => userModel() }) user: User, @Body() data: UpdateUserDto) {
    // `data.Role` may be an ARRAY, and `[]` is truthy — so the presence check is
    // on the FIELD, not on the value. An empty or blanks-only list never gets
    // this far: `ROLE_FIELD` refuses it during body validation.
    const next = data.Role !== undefined ? roleList(data.Role) : null;

    if (next) {
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
      await this.asDuplicateResponse(() => assertUserUnique(data.Login !== user.Login ? data.Login : undefined, data.Email !== user.Email ? data.Email : undefined, user.Id));
    }

    user.Login = data.Login ?? user.Login;
    user.Email = data.Email ?? user.Email;
    user.Role = next ?? user.Role;

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
   * Runs `work`, turning rbac's duplicate-account refusal into the 409 this API
   * has always answered.
   *
   * rbac throws a transport-agnostic {@link ErrorCode} — it has no business
   * knowing about status codes — so the translation belongs here. `__handle_error__`
   * looks the response up by `err.constructor.name`, which is why this rethrows a
   * plain {@link ResourceDuplicated} rather than a subclass: a subclass would miss
   * the 409 mapping entirely and answer 500.
   *
   * The 409 carries WHICH field clashed, not only that something did. The error
   * body is built by spreading the thrown exception's own enumerable properties
   * (`__handle_error__`, @spinajs/http), so `parameter` reaches the client
   * alongside `message` in the shape {@link ValidationFailed} already uses for
   * schema rejections — an ajv-style entry per offending field. A form can then
   * mark the Email input rather than showing "something is already in use"
   * somewhere off to the side.
   */
  protected async asDuplicateResponse<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (!(err instanceof ErrorCode) || err.code !== E_CODES.E_USER_ALREADY_EXISTS) {
        throw err;
      }

      const clashes = ((err.data as { fields?: string[] })?.fields ?? []).slice();
      const duplicated = new ResourceDuplicated(err.message);

      Object.assign(duplicated, {
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

      throw duplicated;
    }
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

}
