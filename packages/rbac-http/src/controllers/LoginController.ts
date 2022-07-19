import { LoginDto } from './../dto/login-dto';
import { BaseController, BasePath, Post, Body, Ok, Get, Cookie, CookieResponse, Unauthorized, NotAllowed } from '@spinajs/http';
import { AuthProvider, Session, SessionProvider, User as UserModel } from '@spinajs/rbac';
import { Autoinject } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { User } from './../decorators';
import _ from 'lodash';

@BasePath('user/auth')
export class LoginController extends BaseController {
  @Autoinject()
  protected Configuration: Configuration;

  @Autoinject()
  protected AuthProvider: AuthProvider;

  @Autoinject()
  protected SessionProvider: SessionProvider;

  @Config('rbac.session.expiration', 120)
  protected SessionExpirationTime: number;

  @Post()
  public async login(@Body() credentials: LoginDto, @User() logged: UserModel) {
    if (logged) {
      return new NotAllowed('User already logged in. Please logout before trying to authorize.');
    }

    const user = await this.AuthProvider.authenticate(credentials.Email, credentials.Password);

    if (!user) {
      return new Unauthorized({
        error: {
          message: 'login or password incorrect',
        },
      });
    }

    await user.Metadata.populate();

    const session = new Session();
    const sData = user.dehydrate();

    session.Data.set('User', sData);

    await this.SessionProvider.save(session);

    // BEWARE: httpOnly coockie, only accesible via http method in browser
    return new CookieResponse('ssid', session.SessionId, this.SessionExpirationTime, true, _.omit(sData, ['Id']), { httpOnly: true });
  }

  @Get()
  public async logout(@Cookie() ssid: string) {
    if (!ssid) {
      return new Ok();
    }

    await this.SessionProvider.delete(ssid);

    // send empty cookie to confirm session deletion
    return new CookieResponse('ssid', null, this.SessionExpirationTime);
  }
}
