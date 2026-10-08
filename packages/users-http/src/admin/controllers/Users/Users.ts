import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Body, Del, Get, Ok, Param, Patch, Post, Query, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { InvalidArgument, ResourceDuplicated } from '@spinajs/exceptions';
import { SortOrder, SqlOperator } from '@spinajs/orm';
import type { ISelectQueryBuilder } from '@spinajs/orm';
import { Filter, FilterableOperators, IColumnFilter, IFilterEntry, IFilterRequest, isFilterGroup, OrderDTO, PaginationDTO } from '@spinajs/orm-http';
import { assertLoginNotReserved, assertUserUnique, create, deleteUser, updateUser, User, UserAlreadyExists, UserCreatedIncomplete, userModel } from '@spinajs/users';
import { GLOBAL, ROLE_NAME_MAX_LENGTH, ROLE_NAME_PATTERN } from '@spinajs/authz';
import type { AuthzCommand, Principal } from '@spinajs/authz';
import { Access, CurrentPrincipal } from '@spinajs/authz-http';
import { AUTHZ_ASSIGNMENT_TABLE } from '@spinajs/authz-rbac';
import { Schema } from '@spinajs/validation';

import { AccountGuard } from '../../../services/AccountGuard.js';
import { asHttpRefusal, userActor } from '../../../services/actor.js';
import { assertCredentialAdmin } from '../../../services/credential-admin.js';
import { freshAuthRefusal } from '../../../services/fresh-auth.js';
import { assignableRoles, executeAsActor, globalRolesOf, replacementCommands } from '../../../services/user-roles.js';
import { requireEveryUser, userRowFor } from '../../../services/users-access.js';

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
 * A single role name, by the rule the configuration applies to role names: an
 * inner space is allowed (a 2.x role such as 'Stock editor'), a blank name or
 * edge whitespace is not.
 *
 * `minLength` alone accepts `' '` and `['  ', '']`, which reached `create()` as
 * an empty role list and produced an account nobody can use; the pattern makes
 * that a 400 naming the field. Banning EDGE whitespace also keeps `uniqueItems`
 * honest: `'user'` and `' user '` would otherwise be two distinct entries
 * denoting one role, and the guard is charged per entry.
 */
const ROLE_NAME = {
  type: 'string',
  minLength: 1,
  maxLength: ROLE_NAME_MAX_LENGTH,
  pattern: ROLE_NAME_PATTERN,
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
    reauthPassword: { type: 'string', description: "The caller's password, for fresh authentication when the e-mail or login of another account changes" },
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
 * and optional relation loading. Every route sits on `@Access('users:<action>')`. A route that
 * addresses one user decides a conditional grant (e.g. `users:update` on `self`) again on that
 * user's row; the list, create and restore need a grant on every user.
 * @tags Admin Users
 */
@BasePath('users')
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
   * @response 401 Unauthorized — no signed-in principal
   * @response 403 Forbidden — no `users:read` on every user (a conditional grant does not list)
   */
  @Get('/')
  @Access('users:read', { fields: 'filter' })
  public async list(
    @CurrentPrincipal() caller: Principal,
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
    // The query cannot apply a residual, so a conditional grant is refused rather than listing everyone.
    await requireEveryUser(caller, 'users:read');

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
   * holds are left out, so a UI cannot offer an operation AuthzAdmin will refuse. The answer is about
   * the caller, not about any user, so any `users:read` grant reaches it.
   * @security cookieAuth
   * @returns {string[]} Role names the caller may assign
   * @response 401 Unauthorized — no signed-in principal
   * @response 403 Forbidden — no `users:read`, or the caller is not a signed-in user
   */
  @Get('roles')
  @Access('users:read')
  public async assignableRoles(@CurrentPrincipal() caller: Principal) {
    return new Ok(await assignableRoles(userActor(caller)));
  }

  /**
   * Get user by UUID (admin)
   * Retrieves a single user record by UUID. Supports optional inclusion of related Metadata.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @param include Relations to include — currently supports: Metadata
   * @returns {User} User account with optional Metadata relation
   * @response 401 Unauthorized — no signed-in principal
   * @response 403 Forbidden — no `users:read` on this user
   * @response 404 User not found
   */
  @Get(':user')
  @Access('users:read', { fields: 'filter' })
  public async getSingleUser(
    @CurrentPrincipal() caller: Principal,
    @Param() user: string,
    @Query({
      type: 'array',
      items: {
        type: 'string',
        enum: ['Metadata'],
      },
    })
    include?: string[],
  ) {
    const found = await userRowFor(caller, 'users:read', () => userModel().query().where('Uuid', user).populate(include ?? []).first());
    return new Ok(found.dehydrateWithRelations({ dateTimeFormat: 'iso' }));
  }

  /**
   * Get user by login (admin)
   * Retrieves a single user record by login name. Supports optional inclusion of related Metadata.
   * @security cookieAuth
   * @param user User login name path parameter
   * @param include Relations to include — currently supports: Metadata
   * @returns {User} User account with optional Metadata relation
   * @response 401 Unauthorized — no signed-in principal
   * @response 403 Forbidden — no `users:read` on this user
   * @response 404 User not found
   */
  @Get('byLogin/:user')
  @Access('users:read', { fields: 'filter' })
  public async getByLogin(
    @CurrentPrincipal() caller: Principal,
    @Param() user: string,
    @Query({
      type: 'array',
      items: {
        type: 'string',
        enum: ['Metadata'],
      },
    })
    include?: string[],
  ) {
    const found = await userRowFor(caller, 'users:read', () => userModel().query().where('Login', user).populate(include ?? []).first());
    return new Ok(found.dehydrateWithRelations({ dateTimeFormat: 'iso' }));
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
   * @response 401 Unauthorized — no signed-in principal
   * @response 403 Forbidden — no `users:create` on every user, the caller is not a signed-in user, or AuthzAdmin refused a requested role (escalation)
   * @response 409 Login or email already in use, naming the clashing field in `parameter`
   */
  @Post('/')
  @Access('users:create')
  public async addUser(@CurrentPrincipal() caller: Principal, @Body() data: CreateUserDto) {
    const by = userActor(caller);
    await requireEveryUser(by, 'users:create');
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
   * the privileged permission from an account must also leave another account in service holding it
   * ({@link AccountGuard.assertCanDemote}). The batch is checked before anything is written; a refused
   * role leaves the login and email untouched too. An empty list is refused rather than applied.
   * Changing the `Email` or `Login` of another account also needs fresh authentication (a login
   * within authn.freshAuth.maxAgeSeconds, or the caller's password in the body field
   * `reauthPassword`) and authn's CredentialAdminGuard (action `password-reset`; users':
   * `users:credentials`, the target covered, no protected role): the password reset goes to that
   * address.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @response 200 User updated successfully
   * @response 400 Validation error — invalid field format, a reserved login, an empty role list or an unknown or non-assignable role
   * @response 401 Unauthorized — no signed-in principal, or a wrong `reauthPassword`
   * @response 403 Forbidden — no `users:update` on this user, the caller is not a signed-in user, AuthzAdmin refused the role change, the account guard refused it (own privilege, last active privileged account), no fresh authentication for an e-mail or login change of another account (`fresh_auth_required`, `session_required`, `impersonating`), or the credential admin guard refused it (`forbidden`, `protected_role`, `escalation`)
   * @response 409 Login or email already in use by another account, naming the clashing field in `parameter`
   * @response 404 User not found
   */
  @Patch(':user')
  @Access('users:update')
  public async updateUser(@CurrentPrincipal() caller: Principal, @Param() user: string, @Body() data: UpdateUserDto, @Req() req: Request) {
    const by = userActor(caller);
    const target = await userRowFor(by, 'users:update', () => userModel().query().where('Uuid', user).populate('Metadata').first());
    const renamed = !!data.Login && data.Login !== target.Login;

    if (renamed) {
      assertLoginNotReserved(data.Login!);
    }

    // `data.Role` may be an ARRAY, and `[]` is truthy — so the presence check is
    // on the FIELD, not on the value.
    const next = data.Role !== undefined ? roleList(data.Role) : null;
    if (next && next.length === 0) {
      throw new InvalidArgument('Role must name at least one role', 'Role');
    }

    // The public password reset mails the address, and the login names the account at sign-in: changing either on another
    // account can hand it over, so it takes what authn-http's admin password reset takes (fresh auth, then the guard),
    // before the account guard, the role dry run, the uniqueness check and any write.
    const changesIdentity = (data.Email ?? target.Email) !== target.Email || (data.Login ?? target.Login) !== target.Login;
    if (changesIdentity && target.Uuid !== by.id) {
      const stale = await freshAuthRefusal(req, this);
      if (stale) {
        return stale;
      }
      await assertCredentialAdmin(by, target.Uuid, 'password-reset');
    }

    let commands: AuthzCommand[] = [];
    if (next) {
      const current = await globalRolesOf(target.Uuid);
      commands = replacementCommands(target.Uuid, current, next);

      if (current.some((r) => !next.includes(r))) {
        await this.AccountGuard.assertCanDemote(by, target, current.filter((r) => next.includes(r)));
      }
    }

    await executeAsActor(by, commands, { reason: 'users-http:update', dryRun: true });

    if (renamed || (data.Email && data.Email !== target.Email)) {
      await this.asDuplicateResponse(() => assertUserUnique(data.Login !== target.Login ? data.Login : undefined, data.Email !== target.Email ? data.Email : undefined, target.Id));
    }

    target.Login = data.Login ?? target.Login;
    target.Email = data.Email ?? target.Email;

    await target.update();
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
   * @response 401 Unauthorized — no signed-in principal
   * @response 403 Forbidden — no `users:delete` on this user, the caller is not a signed-in user, or refused by the account guard (own account, last privileged account)
   * @response 404 User not found
   */
  @Del(':user')
  @Access('users:delete')
  public async removeUser(@CurrentPrincipal() caller: Principal, @Param() user: string) {
    const by = userActor(caller);
    const target = await userRowFor(by, 'users:delete', () => userModel().query().where('Uuid', user).populate('Metadata').first());

    await this.AccountGuard.assertCanDisable(by, target, 'delete');
    await deleteUser(target);

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
   * @response 401 Unauthorized — no signed-in principal
   * @response 403 Forbidden — no `users:delete` on every user
   * @response 404 User not found
   */
  @Patch(':uuid/restore')
  @Access('users:delete')
  public async restoreUser(@CurrentPrincipal() caller: Principal, @Param() uuid: string) {
    await requireEveryUser(caller, 'users:delete');

    // withDeleted: every model query filters soft-deleted rows out by default, and that is the one row this route exists for.
    const user = await userRowFor(caller, 'users:delete', () => userModel().query().withDeleted().where('Uuid', uuid).first());

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
