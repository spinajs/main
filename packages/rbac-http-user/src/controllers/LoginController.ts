import { UserLoginDto } from '../dto/userLogin-dto.js';
import { BaseController, BasePath, Post, Body, Ok, Get, Cookie, Unauthorized, Policy } from '@spinajs/http';
import { AuthProvider, SessionProvider, auth, UserSession } from '@spinajs/rbac';
import { Autoinject } from '@spinajs/di';
import { AutoinjectService, Config, Configuration } from '@spinajs/configuration';
import _ from 'lodash';
import { LoggedPolicy, NotLoggedPolicy } from '@spinajs/rbac-http';

@BasePath('auth')
export class LoginController extends BaseController {
  @Autoinject()
  protected Configuration: Configuration;

  @AutoinjectService('rbac.auth')
  protected AuthProvider: AuthProvider;

  @AutoinjectService('rbac.session')
  protected SessionProvider: SessionProvider;

  @Config('rbac.session.expiration', {
    defaultValue: 120,
  })
  protected SessionExpirationTime: number;

  @Post()
  @Policy(NotLoggedPolicy)
  public async login(@Body() credentials: UserLoginDto) {
    try {
      const user = await auth(credentials.Email, credentials.Password);
      const session = new UserSession();
      const dUser = user.dehydrate();
      session.Data.set('User', dUser);

      // TEMP
      session.Data.set('Authorized', true);

      await this.SessionProvider.save(session);

      this._log.trace('User logged in', user);

      return new Ok(user, {
        Coockies: [
          {
            Name: 'ssid',
            Value: session.SessionId,
            Options: {
              httpOnly: true,
              maxAge: this.SessionExpirationTime,
            },
          },
        ],
      });
    } catch (err) {
      this._log.error(err);

      return new Unauthorized({
        error: {
          code: 'E_AUTH_FAILED',
          message: 'login or password incorrect',
        },
      });
    }
  }

  // @Post('new-password')
  // @Policy(NotLoggedPolicy)
  // public async setNewPassword(@Query() token: string, @Body() pwd: RestorePasswordDto) {
  //   const user = await User.query()
  //     .innerJoin(UserMetadata, function () {
  //       this.where({
  //         Key: 'password:reset:token',
  //         Value: token,
  //       });
  //     })
  //     .populate('Metadata')
  //     .first();

  //   if (!user) {
  //     return new NotFound({
  //       error: {
  //         code: 'ERR_USER_NOT_FOUND',
  //         message: 'No user found for this reset token',
  //       },
  //     });
  //   }

  //   const val = (await user.Metadata['password:reset:start']) as DateTime;
  //   const now = DateTime.now().plus({ seconds: -this.PasswordResetTokenTTL });

  //   if (val < now) {
  //     return new BadRequest({
  //       error: {
  //         code: 'ERR_RESET_TOKEN_EXPIRED',
  //         message: 'Password reset token expired',
  //       },
  //     });
  //   }

  //   if (!this.PasswordValidationService.check(pwd.Password)) {
  //     return new BadRequest({
  //       error: {
  //         code: 'ERR_PASSWORD_RULE',
  //         message: 'Invalid password, does not match password rules',
  //       },
  //     });
  //   }

  //   if (pwd.Password !== pwd.ConfirmPassword) {
  //     return new BadRequest({
  //       error: {
  //         code: 'ERR_PASSWORD_NOT_MATCH',
  //         message: 'Password and repeat password does not match',
  //       },
  //     });
  //   }

  //   const hashedPassword = await this.PasswordProvider.hash(pwd.Password);
  //   user.Password = hashedPassword;

  //   await user.update();

  //   /**
  //    * Delete all reset related meta for user
  //    */
  //   await user.Metadata.delete(/password:reset.*/);

  //   // add to action list
  //   await user.Actions.add(
  //     new UserAction({
  //       Persistent: true,
  //       Action: 'password:reset',
  //     }),
  //   );

  //   // inform others
  //   await this.Queue.emit(new UserPasswordChanged(user.Uuid));
  // }

  // @Post('forgot-password')
  // @Policy(NotLoggedPolicy)
  // public async forgotPassword(@Body() login: UserLoginDto) {
  //   const user = await this.AuthProvider.getByEmail(login.Email);

  //   if (!user.IsActive || user.IsBanned || user.DeletedAt !== null) {
  //     return new InvalidOperation('User is inactive, banned or deleted. Contact system administrator');
  //   }

  //   const token = uuidv4();

  //   // assign meta to user
  //   await (user.Metadata['password:reset'] = true);
  //   await (user.Metadata['password:reset:token'] = token);
  //   await (user.Metadata['password:reset:start'] = DateTime.now());

  //   await user.Actions.add(
  //     new UserAction({
  //       Action: 'user:password:reset',
  //       Data: DateTime.now().toISO(),
  //       Persistent: true,
  //     }),
  //   );

  //   await this.Queue.emit(new UserPasswordRestore(user.Uuid, token));

  //   return new Ok({
  //     reset_token: token,
  //     ttl: this.PasswordResetTokenTTL,
  //   });
  // }

  @Get()
  @Policy(LoggedPolicy)
  public async logout(@Cookie() ssid: string) {
    if (!ssid) {
      return new Ok();
    }

    await this.SessionProvider.delete(ssid);

    // send empty cookie to confirm session deletion
    return new Ok(null, {
      Coockies: [
        {
          Name: 'ssid',
          Value: '',
          Options: {
            httpOnly: true,
            maxAge: 0,
          },
        },
      ],
    });
  }

  // protected async authenticate(user: UserModel, federated?: boolean) {
  //   if (!user) {
  //     return new Unauthorized({
  //       error: {
  //         message: 'login or password incorrect',
  //       },
  //     });
  //   }

  //   await user.Metadata.populate();

  //   const session = new Session();
  //   const dUser = user.dehydrate();
  //   session.Data.set('User', dUser);

  //   // we found user but we still dont know if is authorized
  //   // eg. 2fa auth is not performed
  //   // create session, but user is not yet authorized
  //   session.Data.set('Authorized', false);

  //   // if its federated login, skip 2fa - assume
  //   // external login service provided it
  //   if (this.TwoFactorConfig.enabled || !federated) {
  //     await this.SessionProvider.save(session);

  //     const enabledForUser = await this.TwoFactorAuthProvider.isEnabled(user);

  //     /**
  //      * if 2fa is enabled for user, proceed
  //      */
  //     if (enabledForUser) {
  //       /**
  //        * check if 2fa system is initialized for user eg. private key is generated.
  //        */
  //       const isInitialized = await this.TwoFactorAuthProvider.isInitialized(user);
  //       if (!isInitialized) {
  //         const twoFaResult = await this.TwoFactorAuthProvider.initialize(user);

  //         return new CookieResponse(
  //           'ssid',
  //           session.SessionId,
  //           this.SessionExpirationTime,
  //           true,
  //           {
  //             toFactorAuth: true,
  //             twoFactorAuthFirstTime: true,
  //             method: this.TwoFactorConfig.service,
  //             data: twoFaResult,
  //           },
  //           { httpOnly: true },
  //         );
  //       }

  //       // give chance to execute 2fa eg. send sms or email
  //       await this.TwoFactorAuthProvider.execute(user);

  //       // return session to identify user
  //       // and only info that twoFactor auth is requested
  //       return new CookieResponse(
  //         'ssid',
  //         session.SessionId,
  //         this.SessionExpirationTime,
  //         true,
  //         {
  //           toFactorAuth: true,
  //         },
  //         { httpOnly: true },
  //       );
  //     }
  //   }

  //   // 2fa is not enabled, so we found user, it means it is logged
  //   session.Data.set('Authorized', true);
  //   await this.SessionProvider.save(session);

  //   await this.Queue.emit(new UserLoginSuccess(user.Uuid));

  //   user.LastLoginAt = DateTime.now();
  //   await user.update();

  //   // BEWARE: httpOnly coockie, only accesible via http method in browser
  //   // return coockie session id with additional user data
  //   return new CookieResponse('ssid', session.SessionId, this.SessionExpirationTime, true, dUser, { httpOnly: true });
  // }
}
