import { PasswordDto } from './../dto/password-dto';
import { UserDto } from './../dto/user-dto';
import { User, PasswordProvider } from '@spinajs/rbac';
import * as express from 'express';
import { BaseController, BasePath, Post, Get, Del, Put, Query, Ok, NotFound, Body, Req, PKey } from '@spinajs/http';
import { InvalidArgument } from '@spinajs/exceptions';
import { RawQuery } from '@spinajs/orm';
import { Autoinject, Container, IContainer } from '@spinajs/di';
import { UserDataTransformer, IUserResult } from '../transformers';
import { SORT_ORDER } from '@spinajs/orm/lib/enums';

const OrderSchema = {
  type: 'string',
  enum: ['asc', 'desc'],
};

@BasePath('users')
export class UsersController extends BaseController {
  @Autoinject()
  protected DataTransformer: UserDataTransformer<IUserResult>;

  @Autoinject(Container)
  protected Container: IContainer;

  @Get('/')
  public async listUsers(@Query() search: string, @Query({ type: 'number', min: 1, default: 0 }) page: number, @Query({ type: 'number', min: 1, default: 30 }) perPage: number, @Query() order: string, @Query(OrderSchema) orderDirection: SORT_ORDER, @Req() request: express.Request) {
    const query = User.all()
      .whereNull('DeletedAt')
      .skip((page - 1) * perPage)
      .take(perPage)
      .order(order, orderDirection)
      .populate('Roles')
      .populate('Metadata');
    const countQuery = User.query().select(new RawQuery('count(*) as count')).whereNull('DeletedAt');

    if (search) {
      const searchFunc = function () {
        this.where('Email', 'like', `%${search}%`);
        this.orWhere('Login', 'like', `${search}%`);
        this.orWhere('NiceName', 'like', `%${search}%`);
      };

      query.where(searchFunc);
      countQuery.where(searchFunc);
    }

    const r = await query;
    const c = await countQuery.asRaw<Array<{ count: number }>>();

    if (r.length === 0) {
      return new NotFound('no users met search criteria');
    }

    return new Ok(
      this.DataTransformer.transform(
        {
          Data: r,
          Total: c[0].count,
        },
        request,
      ),
    );
  }

  @Get(':id')
  public async getUser(@PKey() id: number) {
    const user = await User.where({
      Id: id,
    })
      .whereNull('DeletedAt')
      .populate('Metadata')
      .populate('Roles')
      .firstOrFail();

    return new Ok(user);
  }

  @Post('/')
  public async addUser(@Body() user: UserDto) {
    const password = this.Container.resolve<PasswordProvider>(PasswordProvider);
    if (user.Password !== user.ConfirmPassword) {
      throw new InvalidArgument('password does not match');
    }

    let hashedPassword = '';
    let userPassword = user.Password;

    if (!userPassword) {
      userPassword = password.generate();
    }

    hashedPassword = await password.hash(userPassword);
    const entity = new User({
      Email: user.Email,
      Login: user.Login,
      NiceName: user.NiceName,
      Password: hashedPassword,
      CreatedAt: new Date(),
    });

    await entity.insert();

    return new Ok({ Id: entity.Id });
  }

  @Del(':id')
  public async deleteUser(@PKey() id: number) {
    const entity = await User.getOrFail(id);
    await entity.destroy();
    return new Ok();
  }

  @Put(':id')
  public async updateUser(@PKey() id: number, @Body() user: UserDto) {
    const entity = await User.getOrFail(id);

    entity.Email = user.Email;
    entity.NiceName = user.NiceName;
    entity.Login = user.Login;
    await entity.update();

    return new Ok();
  }

  @Put(':id/change-password')
  public async updateUserPassword(@PKey() id: number, @Body() pwd: PasswordDto) {
    if (pwd.Password !== pwd.ConfirmPassword) {
      throw new InvalidArgument('password does not match');
    }

    const entity = await User.getOrFail(id);
    const password = this.Container.resolve<PasswordProvider>(PasswordProvider);
    const hashedPassword = await password.hash(pwd.Password);
    entity.Password = hashedPassword;
    await entity.update();

    return new Ok();
  }
}