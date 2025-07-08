import { BaseController, BasePath, Get, Ok, Policy, Query } from '@spinajs/http';
import { SortOrder } from '@spinajs/orm';
import { Filter, FilterableOperators, FromModel, IColumnFilter, IFilter, OrderDTO, PaginationDTO } from '@spinajs/orm-http';
import { User } from '@spinajs/rbac';
import { AuthorizedPolicy, Permission, Resource } from "@spinajs/rbac-http";

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

    const result = await User.select()
      .populate(include)
      .take(pagination?.limit ?? 10)
      .skip(pagination?.limit * pagination?.page)
      .order(order?.column ?? 'CreatedAt', order?.order ?? SortOrder.DESC)
      .filter(filter, USER_FILTER);

    const count = await User.query().filter(filter, USER_FILTER).count();


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
