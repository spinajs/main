import { LoginDto } from './../dto/login-dto';
import { BaseController, BasePath, Post, Body, Ok, Get, Cookie, CookieResponse, Unauthorized } from '@spinajs/http';
import { AuthProvider, Session, SessionProvider } from '@spinajs/rbac';
import { Autoinject } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { DateTime } from 'luxon';

@BasePath('auth')
export class LoginController extends BaseController {
  @Autoinject()
  protected Configuration: Configuration;

  @Autoinject()
  protected AuthProvider: AuthProvider;

  @Autoinject()
  protected SessionProvider: SessionProvider;

  @Config('acl.session.expiration', 10)
  protected SessionExpirationTime: number;

  @Post()
  public async login(@Body() credentials: LoginDto) {
    const user = await this.AuthProvider.authenticate(credentials.Login, credentials.Password);

    if (!user) {
      return new Unauthorized({
        error: {
          message: 'login or password incorrect',
        },
      });
    }
    const lifetime = DateTime.now().plus({ minutes: this.SessionExpirationTime });

    const uObject = {
      Login: user.Login,
      Email: user.Email,
      NiceName: user.NiceName,
      Metadata: user.Metadata.map((m) => ({ Key: m.Key, Value: m.Value })),
      Role: user.Role,
      Id: user.Id,
    };

    const session = new Session({
      Data: uObject,
      Expiration: lifetime,
    });

    await this.SessionProvider.updateSession(session);

    return new CookieResponse('ssid', session.SessionId, this.SessionExpirationTime, uObject);
  }

  @Get()
  public async logout(@Cookie() ssid: string) {
    if (!ssid) {
      return new Ok();
    }

    await this.SessionProvider.deleteSession(ssid);

    // send empty cookie to confirm session deletion
    return new CookieResponse('ssid', null, this.SessionExpirationTime);
  }
}
