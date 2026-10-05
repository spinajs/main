import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Body, Del, Get, Ok, Param, Patch, Policy, Post, Query } from '@spinajs/http';
import { InvalidArgument, ResourceDuplicated, ResourceNotFound } from '@spinajs/exceptions';
import { SortOrder, SqlOperator } from '@spinajs/orm';
import type { ISelectQueryBuilder } from '@spinajs/orm';
import { Filter, FilterableOperators, FromModel, IColumnFilter, IFilterEntry, IFilterRequest, isFilterGroup, OrderDTO, PaginationDTO } from '@spinajs/orm-http';
import { assertLoginNotReserved, assertUserUnique, create, deleteUser, updateUser, User, UserAlreadyExists, UserCreatedIncomplete, userModel } from '@spinajs/users';
import { AuthorizedPolicy, Permission, Resource, User as CurrentUser } from '@spinajs/authn-http';
import { GLOBAL } from '@spinajs/authz';
import type { AuthzCommand } from '@spinajs/authz';
import { AUTHZ_ASSIGNMENT_TABLE } from '@spinajs/authz-rbac';
import { Schema } from '@spinajs/validation';

import { AccountGuard } from '../../../services/AccountGuard.js';
import { actorPrincipal, asHttpRefusal } from '../../../services/actor.js';
import { assignableRoles, executeAsActor, globalRolesOf, replacementCommands } from '../../../services/user-roles.js';

/**
 * Columns a client may sort by.
 *
 * `OrderDTO.column` is a free-form string and reaches the query builder as an
 * identifier. The compiler escapes it, so this is not an injection hole — but an
 * unknown column produced a driver error and a 500 where the request was simply
 * wrong. Whitelisting turns that into a 400 and keeps the sortable surface a
 * deliberate decision rather than "whatever columns the table happens to have".
 */
const SORTABLE_COLUMNS = ['Uuid', 'Login', 'Email', 'IsActive', 'CreatedAt', 'LastLoginAt', 'DeletedAt'];

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
 * An account holds a role LIST (its GLOBAL assignments), and the roles
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

function filtersOn(entries: IFilterEntry[], column: string): boolean {
  return entries.some((entry) => (isFilterGroup(entry) ? filtersOn(entry.filters, column) : entry.Column === column));
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
    operators: ['eq', 'gte', 'lte', 'lt', 'gt', 'isnull', 'notnull'],
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
    // Holders of live GLOBAL assignments of the named roles. Reads `authz_assignment` on the users
    // connection, like users' `withRole` scope, so assignments kept on another connection are missed.
    column: 'Role',
    operators: ['eq', 'neq', 'in-set', 'nin-set'],
    query: (operator: FilterableOperators, value: any) => {
      const roles = (Array.isArray(value) ? value : [value]).map((r) => String(r));
      if (roles.length === 0) {
        throw new InvalidArgument('The Role filter needs at least one role', 'Role');
      }

      const holders = userModel()
        .query()
        .Driver.select()
        .from(AUTHZ_ASSIGNMENT_TABLE)
        .columns(['subject_id'])
        .where({ subject_type: 'user', subject_role: '', scope_type: GLOBAL.type, scope_id: '' })
        .whereIn('role', roles)
        .where(function () {
          this.whereNull('expires_at').orWhere('expires_at', '>', new Date());
        }) as unknown as ISelectQueryBuilder<unknown>;

      return function () {
        if (operator === 'neq' || operator === 'nin-set') {
          this.whereNotIn('Uuid', holders);
        } else {
          this.whereIn('Uuid', holders);
        }
      };
    },
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
  @Autoinject(AccountGuard)
  protected AccountGuard: AccountGuard;

  /**
   * List users (admin)
   * Returns a paginated, sortable, filterable list of all users. Supports optional inclusion
   * of related Metadata. The total user count (matching current filters) is returned in the
   * X-Total-Count response header.
   * Filterable fields: Uuid (eq), Email (eq, like), Login (eq, like), CreatedAt (eq, gte, lte, lt, gt),
   * LastLoginAt and DeletedAt (eq, gte, lte, lt, gt, isnull, notnull), IsActive (eq),
   * Role (eq, neq, in-set: holds any of the listed roles at GLOBAL, nin-set: holds none of them),
   * user:niceName metadata (eq, neq, like). Soft-deleted accounts are listed only when the
   * filter has a DeletedAt condition.
   * @security cookieAuth
   * @param pagination.page Page number (zero-based)
   * @param pagination.limit Number of users per page (default: 10, max: 100)
   * @param order.column Column to sort by (default: CreatedAt). One of Uuid, Login, Email, IsActive, CreatedAt, LastLoginAt, DeletedAt
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

    // Soft-deleted accounts are hidden by every model query, so a DeletedAt
    // condition could otherwise only ever match nothing.
    const withDeleted = filtersOn(filter?.filters ?? [], 'DeletedAt');

    const query = userModel()
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

    const countQuery = userModel()
      .query()
      .filter(filter?.filters ?? [], filter?.op, USER_FILTER);

    if (withDeleted) {
      query.withDeleted();
      countQuery.withDeleted();
    }

    const result = await query;
    const count = await countQuery.selectCount();

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
   * Returns the configured roles the caller may grant at GLOBAL: those AuthzAdmin accepts in a
   * dry-run grant by the caller. Non-assignable roles and anything granting more than the caller
   * holds are left out, so a UI cannot offer an operation AuthzAdmin will refuse.
   * @security cookieAuth
   * @returns {string[]} Role names the caller may assign
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — readAny permission required on users resource, or no caller
   */
  @Get('roles')
  @Permission(['readAny', 'readOwn'])
  public async assignableRoles(@CurrentUser() actor: User) {
    return new Ok(await assignableRoles(await actorPrincipal(actor)));
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
   * Creates an inactive account without a password: `create()` sends the owner an invite to set
   * one, so nothing has to travel back through an administrator. Activate the account once they
   * have. `Role` takes one role name or a list of them, granted at GLOBAL through AuthzAdmin with
   * the caller as actor; one refused entry refuses the whole request and nothing is created.
   * When a step after the grants fails, the account exists: the answer is still 200 with the
   * account, plus `Incomplete: { resendInvite }` telling whether the invite must be sent again.
   * @security cookieAuth
   * @returns {User} Created user account
   * @response 400 Validation error — missing required fields, invalid format, an empty, unknown or non-assignable role, a reserved login, or a protected metadata key
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — createAny permission required, no caller, or AuthzAdmin refused a requested role (escalation)
   * @response 409 Login or email already in use, naming the clashing field in `parameter`
   */
  @Post('/')
  @Permission(['createAny', 'createOwn'])
  public async addUser(@CurrentUser() actor: User, @Body() data: CreateUserDto) {
    const by = await actorPrincipal(actor);
    const roles = roleList(data.Role);

    try {
      const { User: created } = await this.asDuplicateResponse(() => asHttpRefusal(() => create({ Email: data.Email, Login: data.Login, Metadata: data.Metadata }, roles, by)));
      return new Ok(created.dehydrateWithRelations({ dateTimeFormat: 'iso' }));
    } catch (err) {
      if (!(err instanceof UserCreatedIncomplete)) {
        throw err;
      }

      // A retry would only get a 409: answer with the account that exists.
      const created = await userModel().query().where('Uuid', err.data.user).populate('Metadata').firstOrFail();
      return new Ok({ ...created.dehydrateWithRelations({ dateTimeFormat: 'iso' }), Incomplete: { resendInvite: err.data.resendInvite } });
    }
  }

  /**
   * Update user (admin)
   * Partially updates a user account. All fields are optional — only provided fields are changed.
   * Metadata is NOT handled here; use the `/user/:uuid/metadata` routes.
   * `Role` takes one role name or a list of them and REPLACES the account's GLOBAL roles: one
   * AuthzAdmin batch, run as the caller, grants the added roles and revokes the ones left out, so
   * AuthzAdmin's guard decides escalation, self lockout and the last holder. A replacement that takes
   * the privileged permission from an account must also leave another active account holding it
   * ({@link AccountGuard.assertCanDemote}). The batch is checked before anything is written; a refused
   * role leaves the login and email untouched too. An empty list is refused rather than applied.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @response 200 User updated successfully
   * @response 400 Validation error — invalid field format, a reserved login, an empty role list or an unknown or non-assignable role
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny permission required, no caller, AuthzAdmin refused the role change, or the account guard refused it (own privilege, last active privileged account)
   * @response 409 Login or email already in use by another account, naming the clashing field in `parameter`
   * @response 404 User not found
   */
  @Patch(':user')
  @Permission(['updateAny', 'updateOwn'])
  public async updateUser(@CurrentUser() actor: User, @FromModel({ queryField: 'Uuid', include: ['Metadata'], model: () => userModel() }) user: User, @Body() data: UpdateUserDto) {
    const by = await actorPrincipal(actor);
    const renamed = !!data.Login && data.Login !== user.Login;

    if (renamed) {
      assertLoginNotReserved(data.Login!);
    }

    // `data.Role` may be an ARRAY, and `[]` is truthy — so the presence check is
    // on the FIELD, not on the value.
    const next = data.Role !== undefined ? roleList(data.Role) : null;
    if (next && next.length === 0) {
      throw new InvalidArgument('Role must name at least one role', 'Role');
    }

    let commands: AuthzCommand[] = [];
    if (next) {
      const current = await globalRolesOf(user.Uuid);
      commands = replacementCommands(user.Uuid, current, next);

      if (current.some((r) => !next.includes(r))) {
        await this.AccountGuard.assertCanDemote(by, user, current.filter((r) => next.includes(r)));
      }
    }

    await executeAsActor(by, commands, { reason: 'users-http:update', dryRun: true });

    if (renamed || (data.Email && data.Email !== user.Email)) {
      await this.asDuplicateResponse(() => assertUserUnique(data.Login !== user.Login ? data.Login : undefined, data.Email !== user.Email ? data.Email : undefined, user.Id));
    }

    user.Login = data.Login ?? user.Login;
    user.Email = data.Email ?? user.Email;

    await user.update();
    await executeAsActor(by, commands, { reason: 'users-http:update' });

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
   * @response 403 Forbidden — deleteAny permission required, no caller, or refused by the account guard (own account, last privileged account)
   * @response 404 User not found
   */
  @Del(':user')
  @Permission(['deleteAny', 'deleteOwn'])
  public async removeUser(@CurrentUser() actor: User, @FromModel({ queryField: 'Uuid', include: ['Metadata'], model: () => userModel() }) user: User) {
    await this.AccountGuard.assertCanDisable(await actorPrincipal(actor), user, 'delete');
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

    await updateUser(user, { DeletedAt: null as any });

    return new Ok();
  }

  /**
   * Runs `work`, turning rbac's duplicate-account refusal into the 409 this API
   * has always answered.
   *
   * rbac throws a transport-agnostic {@link UserAlreadyExists} — it has no business
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
      if (!(err instanceof UserAlreadyExists)) {
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
