import { AuthProvider, PasswordProvider } from './interfaces';
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

  public async authenticate(email: string, password: string): Promise<User> {
    const result = await User.where({ Email: email, DeletedAt: null }).first();

    if (!result) {
      return null;
    }

    const valid = await this.PasswordProvider.verify(result.Password, password);
    if (valid) {
      return result;
    }

    return null;
  }
}
