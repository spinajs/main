import { BaseController, BasePath, Get, Ok, Policy, Query } from '@spinajs/http';
import { SortOrder } from '@spinajs/orm';
import { CustomFilterSchema, Filter, FromModel, IFilter, OrderDTO, PaginationDTO } from '@spinajs/orm-http';
import { User } from '@spinajs/rbac';
import { AuthorizedPolicy, Permission, Resource } from "@spinajs/rbac-http";

/**
 * User model filter
 * We declare it here to not include orm-http in rbac module
 * and add unnessesery dependency
 */
const USER_FILTER: CustomFilterSchema[] = [
  {
    Column: 'Uuid',
    Operators: ['eq'],
  },
  {
    Column: 'Email',
    Operators: ['eq', 'like'],
  },
  {
    Column: 'Login',
    Operators: ['eq', 'like'],
  },
  {
    Column: 'CreatedAt',
    Operators: ['eq', 'gte', 'lte', 'lt', 'gt'],
  },
  {
    Column: 'LastLoginAt',
    Operators: ['eq', 'gte', 'lte', 'lt', 'gt'],
  },
  {
    Column: 'DeletedAt',
    Operators: ['eq', 'gte', 'lte', 'lt', 'gt', 'isnull', 'notnull'],
  },
  {
    Column: 'IsActive',
    Operators: ['eq'],
  },
  {
    Column: 'Role',
    Operators: ['eq', 'neq']
  }
];

@BasePath('users')
@Policy(AuthorizedPolicy)
@Resource('users')
export class Users extends BaseController {
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
    filter?: IFilter[],
  ) {
    debugger;
    const result = await User.select()
      .populate(include)
      .take(pagination?.limit ?? 10)
      .skip(pagination?.limit * pagination?.page)
      .order(order?.column ?? 'CreatedAt', order?.order ?? SortOrder.DESC)
      .filter(filter);

    const count = await User.query().filter(filter).count();
     

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
  public async getSingleUser(@FromModel() user: string) {
    return new Ok(user);
  }

  // @Post('/')
  // public async addUser(@Body() user: UserDto) {
  //   const password = this._container.resolve<PasswordProvider>(PasswordProvider);
  //   if (user.Password !== user.ConfirmPassword) {
  //     throw new InvalidArgument('password does not match');
  //   }
  //   let hashedPassword = '';
  //   let userPassword = user.Password;
  //   if (!userPassword) {
  //     userPassword = password.generate();
  //   }
  //   hashedPassword = await password.hash(userPassword);
  //   const entity = new User({
  //     Email: user.Email,
  //     Login: user.Login,
  //     NiceName: user.NiceName,
  //     Password: hashedPassword,
  //     CreatedAt: DateTime.now(),
  //     Role: user.Role,
  //   });
  //   await entity.insert();
  //   return new Ok({ Id: entity.Id });
  // }

}
