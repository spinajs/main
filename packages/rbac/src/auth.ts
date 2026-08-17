import { AthenticationErrorCodes, AuthProvider, PasswordProvider } from './interfaces.js';
import { User, UserBase } from './models/User.js';
import { Autoinject, Container, IContainer, Injectable } from '@spinajs/di';
import { AutoinjectService } from '@spinajs/configuration';
import { _check_arg, _is_email, _is_object, _is_string, _max_length, _non_empty, _non_nil, _or, _trim } from '@spinajs/util';
import { ErrorCode } from '@spinajs/exceptions';
import { userModel } from './model-token.js';

@Injectable(AuthProvider)
export class SimpleDbAuthProvider implements AuthProvider<User> {
  @Autoinject(Container)
  protected Container: IContainer;

  @AutoinjectService('rbac.password')
  protected PasswordProvider: PasswordProvider;

  public async exists(userOrEmail: User | string): Promise<boolean> {
    const result = await userModel().where('Email', userOrEmail instanceof User ? userOrEmail.Email : userOrEmail).first();
    if (result) {
      return true;
    }

    return false;
  }

  public async getByLogin(login: string): Promise<User> {
    return await User.getByLogin(login);
  }

  public async getByEmail(email: string): Promise<User> {
    return User.getByEmail(email);
  }

  public async getByUUID(uuid: string): Promise<User> {
    return User.getByUuid(uuid);
  }

  public async authenticate(email: string, password: string): Promise<User> {
    _check_arg(_trim(), _non_empty(), _is_email(), _max_length(64))(email, 'email');
    _check_arg(_trim(), _non_empty(), _max_length(64))(password, 'password');

    // NOTE: every ErrorCode below carries an explicit message. `Error` with an
    // empty message logs as a blank line ( the default layout renders
    // `${message} ... ${error:message}` ), which made failed logins show up as
    // `ERROR  Exception:  (http)` with nothing to go on.
    const user = await UserBase.query().whereEmail(email).notDeleted().populate('Metadata').firstOrThrow(new ErrorCode(AthenticationErrorCodes.E_INVALID_CREDENTIALS, 'no user with given email'));

    const valid = await this.PasswordProvider.verify(user.Password, password);
    if (!valid) {
      throw new ErrorCode(AthenticationErrorCodes.E_INVALID_CREDENTIALS, 'invalid password');
    }

    if (user.IsBanned) {
      throw new ErrorCode(AthenticationErrorCodes.E_USER_BANNED, 'user is banned');
    }

    if (!user.IsActive) {
      throw new ErrorCode(AthenticationErrorCodes.E_USER_NOT_ACTIVE, 'user is not active');
    }

    return user;
  }

  public async isBanned(userOrEmail: User | string): Promise<boolean> {
    const result = await userModel().query().whereUser(userOrEmail).checkIsBanned();
    return result;
  }

  public async isActive(userOrEmail: User | string): Promise<boolean> {
    const result = await userModel().query().whereUser(userOrEmail).checkIsActive();
    return result;
  }

  public async isDeleted(userOrEmail: User | string): Promise<boolean> {
    const result = await userModel().query().whereUser(userOrEmail).notDeleted().first();
    return result === undefined;
  }
}
