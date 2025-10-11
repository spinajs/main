import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Body, Get, Ok, Patch, Policy, Post, Query } from '@spinajs/http';
import { SortOrder } from '@spinajs/orm';
import { Filter, FilterableOperators, FromModel, IColumnFilter, IFilterRequest, OrderDTO, PaginationDTO } from '@spinajs/orm-http';
import { create, PasswordProvider, User, UserMetadataBase } from '@spinajs/rbac';
import { AuthorizedPolicy, Permission, Resource } from "@spinajs/rbac-http";
import { Schema } from '@spinajs/validation';

@Schema({
  type: 'object',
  $id: 'arrow.common.userDto',
  properties: {
    Login: { type: 'string', minLength: 3, maxLength: 32 },
    Email: { type: 'string', format: 'email' },
    Role: { type: 'string', minLength: 1, maxLength: 32 },
    Metadata: {
      type: 'object',
      $id: 'arrow.common.userMetadata',
      properties: {
        Key: { type: 'string', minLength: 1, maxLength: 64 },
        Value: { type: 'string', minLength: 0, maxLength: 256 },
      },
      additionalProperties: true,
      description: 'Additional metadata for the user, can be used to store custom data',
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

@BasePath('users')
@Policy(AuthorizedPolicy)
@Resource('users')
export class Users extends BaseController {

  @Autoinject()
  protected PasswordProvider: PasswordProvider

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
      .leftJoin(UserMetadataBase, function () {

        // TODO: allow to inject custom meta props that need to be selected
        // eg. user:niceName, user:avatar etc.
        // this is used for filtering / sorting by custom meta props
        this.where('Key', 'user:niceName');

      }, function () {
        this.select('Value', "user:niceName")
      })
      .populate(include)
      .take(pagination?.limit ?? 10)
      .skip(pagination?.limit * pagination?.page)
      .order(order?.column ?? 'CreatedAt', order?.order ?? SortOrder.DESC)
      .filter(filter?.filters, filter?.op, USER_FILTER);

    const count = await User.query().filter(filter?.filters, filter?.op, USER_FILTER).count();


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


  @Post("/")
  @Permission(['createAny'])
  public async addUser(
    @Body() data: UserDto,
  ) {

    const temporaryPassword = this.PasswordProvider.generate();
    const u = await create(data.Email, data.Login, temporaryPassword, [data.Role]);

    for (const key in data.Metadata) {
      u.User.Metadata[key] = data.Metadata[key];
    }
    await u.User.Metadata.update();
    return new Ok();
  }


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
