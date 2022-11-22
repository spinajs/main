import { AthenticationErrorCodes, AuthProvider, IAuthenticationResult, PasswordProvider } from './interfaces';
import { User } from './models/User';
import { Autoinject, Container, IContainer, Injectable } from '@spinajs/di';
import { AutoinjectService } from '@spinajs/configuration';

@Injectable(AuthProvider)
export class SimpleDbAuthProvider implements AuthProvider<User> {
  @Autoinject(Container)
  protected Container: IContainer;

  @AutoinjectService('rbac.password.provider')
  protected PasswordProvider: PasswordProvider;

  public async exists(user: User | string): Promise<boolean> {
    const result = await User.where('Email', user instanceof User ? user.Email : user).first();
    if (result) {
      return true;
    }

    return false;
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
      return eInvalidCredentials;
    }

    if (result.IsBanned) {
      return {
        Error: {
          Code: AthenticationErrorCodes.E_USER_BANNED,
        },
      };
    }

    if (result.IsActive) {
      return {
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
