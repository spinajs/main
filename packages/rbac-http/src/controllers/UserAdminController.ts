import { BaseController, BasePath } from '@spinajs/http';
import { Resource } from './../decorators';

@Resource('user')
@BasePath('user')
export class UsersController extends BaseController {
  //   @Get('/')
  //   @Permission('readAny')
  //   public async listUsers(@Query() search: string, @Query({ type: 'number', minimum: 1 }) page: number, @Query({ type: 'number', minimum: 1 }) perPage: number, @Query() order: string, @Query(OrderSchema) orderDirection: SORT_ORDER, @Req() request: express.Request) {
  //     /**
  //      * implement include query param
  //      * do not return internal id
  //      *
  //      */
  //     const query = User.all()
  //       .whereNull('DeletedAt')
  //       .skip((page - 1) * perPage)
  //       .take(perPage)
  //       .order(order, orderDirection)
  //       .populate('Metadata');
  //     const countQuery = User.query().select(new RawQuery('count(*) as count')).whereNull('DeletedAt');
  //     if (search) {
  //       const searchFunc = function () {
  //         this.where('Email', 'like', `%${search}%`);
  //         this.orWhere('NiceName', 'like', `%${search}%`);
  //       };
  //       query.where(searchFunc);
  //       countQuery.where(searchFunc);
  //     }
  //     const r = await query;
  //     const c = await countQuery.asRaw<Array<{ count: number }>>();
  //     if (r.length === 0) {
  //       return new NotFound('no users met search criteria');
  //     }
  //     return new Ok(
  //       this.DataTransformer.transform(
  //         {
  //           Data: r.map((u) => u.dehydrate()),
  //           Total: c[0].count,
  //         },
  //         request,
  //       ),
  //     );
  //   }
  //   @Post('/')
  //   public async addUser(@Body() user: UserDto) {
  //     const password = this._container.resolve<PasswordProvider>(PasswordProvider);
  //     if (user.Password !== user.ConfirmPassword) {
  //       throw new InvalidArgument('password does not match');
  //     }
  //     let hashedPassword = '';
  //     let userPassword = user.Password;
  //     if (!userPassword) {
  //       userPassword = password.generate();
  //     }
  //     hashedPassword = await password.hash(userPassword);
  //     const entity = new User({
  //       Email: user.Email,
  //       Login: user.Login,
  //       NiceName: user.NiceName,
  //       Password: hashedPassword,
  //       CreatedAt: DateTime.now(),
  //       Role: user.Role,
  //     });
  //     await entity.insert();
  //     return new Ok({ Id: entity.Id });
  //   }
  //   @Patch('role/add/:login/:role')
  //   @Permission('updateAny')
  //   public async addRole(@Param() login: string, @Param() role: string) {}
  //   @Patch('role/revoke/:login/:role')
  //   @Permission('updateAny')
  //   public async revokeRole(@Param() login: string, @Param() role: string) {}
  //   @Patch('update/:login')
  //   @Permission('updateAny')
  //   public async update(@Param() login: string, @Body() data: any) {}
}
