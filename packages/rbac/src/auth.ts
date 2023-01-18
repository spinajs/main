import { AthenticationErrorCodes, AuthProvider, IAuthenticationResult, PasswordProvider } from './interfaces';
import { User } from './models/User';
import { Autoinject, Container, IContainer, Injectable } from '@spinajs/di';
import { AutoinjectService } from '@spinajs/configuration';

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
    const result = await User.where('Login', login).first();
    return result;
  }

  public async getByEmail(email: string): Promise<User> {
    const result = await User.where('Email', email).first();
    return result;
  }

  public async getByUUID(uuid: string): Promise<User> {
    const result = await User.where('Uuid', uuid).first();
    return result;
  }

  public async authenticate(email: string, password: string): Promise<IAuthenticationResult<User>> {
    const result = await User.where({ Email: email, DeletedAt: null }).first();
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

    if (result.IsBanned) {
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

  public async isBanned(email: string): Promise<boolean> {
    const result = await User.where({ Email: email, IsBanned: true }).first();

    return result !== null;
  }

  public async isActive(email: string): Promise<boolean> {
    const result = await User.where({ Email: email, IsActive: true }).first();
    return result !== null;
  }

  public async isDeleted(email: string): Promise<boolean> {
    const result = await User.where('Email', email).whereNotNull('DeletedAt').first();
    return result !== null;
  }
}
