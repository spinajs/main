import { BaseController, BasePath, Get, Ok, Policy, Query } from '@spinajs/http';
import { CustomFilterSchema, Filter, IFilter, OrderDTO, PaginationDTO } from '@spinajs/orm-http';
import { User } from '@spinajs/rbac';
import { LoggedPolicy } from "@spinajs/rbac-http";

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
];

@BasePath('users')
@Policy(LoggedPolicy)
export class UserAdminController extends BaseController {
  @Get("/")
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
    const result = await User.select()
      .populate(include)
      .take(pagination?.limit ?? 10)
      .skip(pagination?.limit * pagination?.page)
      .order(order?.column ?? 'CreatedAt', order?.order ?? 'DESC')
      .filter(filter);

    const { count } = await User.query().count('*', 'count').filter(filter).takeFirst().asRaw<{ count: number }>();

    return new Ok(
      result.map((x) => x.dehydrateWithRelations()),
      {
        Headers: [
          {
            Name: 'X-Count',
            Value: count,
          },
        ],
      },
    );
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
  // @Patch('role/add/:login/:role')
  // @Permission('updateAny')
  // public async addRole(@Param() login: string, @Param() role: string) {}
  // @Patch('role/revoke/:login/:role')
  // @Permission('updateAny')
  // public async revokeRole(@Param() login: string, @Param() role: string) {}
  // @Patch('update/:login')
  // @Permission('updateAny')
  // public async update(@Param() login: string, @Body() data: any) {}
}
