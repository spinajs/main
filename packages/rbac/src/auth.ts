import { AthenticationErrorCodes, AuthProvider, IAuthenticationResult, PasswordProvider } from './interfaces.js';
import { USER_COMMONT_MEDATA, User } from './models/User.js';
import { Autoinject, Container, IContainer, Injectable } from '@spinajs/di';
import { AutoinjectService } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';

@Injectable(AuthProvider)
export class SimpleDbAuthProvider implements AuthProvider<User> {
  @Autoinject(Container)
  protected Container: IContainer;

  @AutoinjectService('rbac.password')
  protected PasswordProvider: PasswordProvider;

  public async exists(userOrEmail: User | string): Promise<boolean> {
    const result = await User.where('Email', userOrEmail instanceof User ? userOrEmail.Email : userOrEmail).first();
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

  public async authenticate(email: string, password: string): Promise<IAuthenticationResult<User>> {

    const result = await User.where({ Email: email, DeletedAt: null }).populate("Metadata", function () {
      this.where('Key', 'like', '%user:ban:%')
    }).first();

    const eInvalidCredentials = {
      Error: {
        Code: AthenticationErrorCodes.E_INVALID_CREDENTIALS,
        Message: 'Invalid user credentials, or user not exist.',
      },
    };

    /**
     * If user not exists, is deleted, or password dont match
     * return E_INVALID_CREDENTIALS for security reasons ( so attaker wont now if email is valid, or password don match)
     */
    if (!result) {
      return eInvalidCredentials;
    }

    const valid = await this.PasswordProvider.verify(result.Password, password);
    if (!valid) {
      return {
        User: undefined,
        ...eInvalidCredentials,
      };
    }

    if (result.Metadata[USER_COMMONT_MEDATA.USER_BAN_IS_BANNED] === true) {
      return {
        User: result,
        Error: {
          Code: AthenticationErrorCodes.E_USER_BANNED,
        },
      };
    }

    if (result.IsActive) {
      return {
        User: result,
        Error: {
          Code: AthenticationErrorCodes.E_USER_NOT_ACTIVE,
        },
      };
    }

    return {
      User: result,
    };
  }

  public async isBanned(userOrEmail: User | string): Promise<boolean> {

    const result = await User.where({ Email: userOrEmail instanceof User ? userOrEmail.Email : userOrEmail }).populate("Metadata", function () {
      this.where("Key", USER_COMMONT_MEDATA.USER_BAN_IS_BANNED)
        .andWhere("Value", true);
    }).first();

    return result?.Metadata['user:ban:is_banned'] === true;
  }

  public async isActive(userOrEmail: User | string): Promise<boolean> {

    if (userOrEmail === null || userOrEmail === undefined || userOrEmail === "") {
      throw new InvalidArgument("userOrEmail cannot be null or empty");
    }

    const result = await User.where({ Email: userOrEmail instanceof User ? userOrEmail.Email : userOrEmail, IsActive: true }).first();
    return result !== undefined;
  }

  public async isDeleted(userOrEmail: User | string): Promise<boolean> {

    if (userOrEmail === null || userOrEmail === undefined || userOrEmail === "") {
      throw new InvalidArgument("userOrEmail cannot be null or empty");
    }

    const result = await User.where('Email', userOrEmail instanceof User ? userOrEmail.Email : userOrEmail).whereNotNull('DeletedAt').first();
    return result !== undefined;
  }
}
