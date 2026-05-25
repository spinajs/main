import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Body, Get, Ok, Patch, Policy, Post, Query } from '@spinajs/http';
import { SortOrder } from '@spinajs/orm';
import { Filter, FilterableOperators, FromModel, IColumnFilter, IFilterRequest, OrderDTO, PaginationDTO } from '@spinajs/orm-http';
import { create, PasswordProvider, User } from '@spinajs/rbac';
import { AuthorizedPolicy, Permission, Resource } from "@spinajs/rbac-http";
import { Schema } from '@spinajs/validation';

@Schema({
  type: 'object',
  $id: 'arrow.common.userDto',
  properties: {
    Login: { type: 'string', minLength: 3, maxLength: 32, description: 'Unique login name (3–32 characters)' },
    Email: { type: 'string', format: 'email', description: 'Unique email address' },
    Role: { type: 'string', minLength: 1, maxLength: 32, description: 'RBAC role to assign to the user' },
    Metadata: {
      type: 'object',
      $id: 'arrow.common.userMetadata',
      properties: {
        Key: { type: 'string', minLength: 1, maxLength: 64, description: 'Metadata key' },
        Value: { type: 'string', minLength: 0, maxLength: 256, description: 'Metadata value' },
      },
      additionalProperties: true,
      description: 'Optional key-value metadata to attach to the user account',
    },
  },
  required: ['Login', 'Email', 'Role'],
})
class UserDto {
  public Login: string;
  public Email: string;
  public Role: string;

  public Metadata?: { [key: string]: any };

  constructor(data: Partial<UserDto>) {
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
    operators: ['eq', 'neq']
  },
  {
    column: 'user:niceName',
    operators: ['eq', 'neq', 'like', 'b-like', 'e-like'],
    query: (operator: FilterableOperators, value: any) => {
      return function () {
        this.whereExist("Metadata", function () {
          this.where('Key', "user:niceName");
          switch (operator) {
            case 'eq':
            case 'neq':
              this.where('Value', operator, value)
              break;
            case 'like':
              this.where('Value', operator, `%${value}%`)
              break;
            case 'b-like':
              this.where('Value', operator, `%${value}`)
              break;
            case 'e-like':
              this.where('Value', operator, `${value}%`)
              break;

          }
        })
      }
    }
  }
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
  protected PasswordProvider: PasswordProvider

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
   * @param pagination.limit Number of users per page (default: 10)
   * @param order.column Column to sort by (default: CreatedAt)
   * @param order.order Sort direction: ASC or DESC (default: DESC)
   * @param include Relations to include — currently supports: Metadata
   * @returns {IUserData[]} Paginated list of user accounts, each with optional Metadata relation
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — readAny permission required on users resource
   */
  @Get("/")
  @Permission(['readAny'])
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
    const result = await User.select()
      .leftJoin("Metadata", function () {

        // TODO: allow to inject custom meta props that need to be selected
        // eg. user:niceName, user:avatar etc.
        // this is used for filtering / sorting by custom meta props
        this.where('Key', 'user:niceName');

      }, function () {
        this.select('Value', "user:niceName")
      })
      .populate(include ?? [])
      .take(pagination?.limit ?? 10)
      .skip((pagination?.limit ?? 0) * (pagination?.page ?? 0))
      .order(order?.column ?? 'CreatedAt', order?.order ?? SortOrder.DESC)
      .filter(filter?.filters ?? [], filter?.op, USER_FILTER);

    const count = await User.query().filter(filter?.filters ?? [], filter?.op, USER_FILTER).selectCount();


    return new Ok(
      result.map((x) => x.dehydrateWithRelations({
        dateTimeFormat: "iso"
      })),
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
   * Get user by UUID (admin)
   * Retrieves a single user record by UUID. Supports optional inclusion of related Metadata.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @param include Relations to include — currently supports: Metadata
   * @returns {IUserData} User account with optional Metadata relation
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — readAny permission required on users resource
   * @response 404 User not found
   */
  @Get(":user")
  public async getSingleUser(@FromModel({ queryField: "Uuid" }) user: User, @Query({
    type: 'array',
    items: {
      type: 'string',
      enum: ['Metadata'],
    },
  })
  include?: string[]) {
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
   * @returns {IUserData} User account with optional Metadata relation
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — readAny permission required on users resource
   * @response 404 User not found
   */
  @Get("byLogin/:user")
  public async getByLogin(@FromModel({ queryField: "Login" }) user: User, @Query({
    type: 'array',
    items: {
      type: 'string',
      enum: ['Metadata'],
    },
  })
  include?: string[]) {
    // linter hack, to alow incldue param,it is used by FromModel qery arg
    include;
    return new Ok(user.dehydrateWithRelations({ dateTimeFormat: 'iso' }));
  }


  /**
   * Create user (admin)
   * Creates a new user account with a system-generated temporary password.
   * The temporary password is not returned — it should be delivered to the user via email or other channel.
   * @security cookieAuth
   * @returns {IUserData} Created user account
   * @response 400 Validation error — missing required fields or invalid format
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — createAny permission required on users resource
   * @response 409 Login or email already in use
   */
  @Post("/")
  @Permission(['createAny'])
  public async addUser(
    @Body() data: UserDto,
  ) {

    const temporaryPassword = this.PasswordProvider.generate();
    const u = await create(data.Email, data.Login, temporaryPassword, [data.Role], undefined, data.Metadata);
    return new Ok(u);
  }


  /**
   * Update user (admin)
   * Partially updates a user account. All fields are optional — only provided fields are changed.
   * Metadata is merged: existing keys are updated, new keys are added, unlisted keys are preserved.
   * @security cookieAuth
   * @param user User UUID path parameter
   * @response 200 User updated successfully
   * @response 400 Validation error — invalid field format
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny permission required on users resource
   * @response 404 User not found
   * @response 409 Login or email already in use by another account
   */
  @Patch(":user")
  @Permission(['updateAny'])
  public async updateUser(
    @FromModel({ queryField: "Uuid" }) user: User,
    @Body() data: UserDto,
  ) {

    user.Login = data.Login ?? user.Login;
    user.Email = data.Email ?? user.Email;

    // TODO
    // fix array assign 
    user.Role = data.Role ? [data.Role] : user.Role;

    if (data.Metadata) {
      for (const key in data.Metadata) {
        user.Metadata[key] = data.Metadata[key];
      }
    }

    await user.update();
    await user.Metadata.update();

    return new Ok();
  }


}
