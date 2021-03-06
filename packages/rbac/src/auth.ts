import { AuthProvider, PasswordProvider } from './interfaces';
import { User } from './models/User';
import { Autoinject, Container, IContainer, Injectable } from '@spinajs/di';

@Injectable(AuthProvider)
export class SimpleDbAuthProvider implements AuthProvider<User> {
  @Autoinject(Container)
  protected Container: IContainer;

  public async exists(user: User | string): Promise<boolean> {
    const result = await User.where('Email', user instanceof User ? user.Email : user).first();
    if (result) {
      return true;
    }

    return false;
  }

  public async authenticate(email: string, password: string): Promise<User> {
    const pwd = this.Container.resolve(PasswordProvider);
    const result = await User.where({ Email: email, DeletedAt: null }).first();

    if (!result) {
      return null;
    }

    const valid = await pwd.verify(result.Password, password);
    if (valid) {
      return result;
    }

    return null;
  }
}
