import { Log, Logger } from '@spinajs/log';
import { Command, Option } from '@spinajs/cli';
import { DI } from '@spinajs/di';
import { AuthzService, SYSTEM } from '@spinajs/authz';
import { RbacCliCommand } from './RbacCliCommand.js';
import { create } from '../actions.js';

interface UserCreationOptions {
  email: string;
  roles?: string;
  login: string;
  password?: string;
}

@Command('rbac:user-create', 'Creates user with given credentials')
@Option('-e, --email <email>', true, 'user email')
@Option('-r, --roles <roles>', false, 'user roles, comma separated; granted at global scope through AuthzAdmin; default authz.rbac.defaultRoles')
@Option('-l, --login <login>', true, 'user login')
@Option('-p, --password <password>', false, 'user password; if not set, the user is invited by mail to set one')
export class CreateUser extends RbacCliCommand {
  @Logger('rbac')
  protected Log: Log;

  public async execute(options: UserCreationOptions): Promise<void> {
    try {
      const authz = (await DI.resolve(AuthzService)) as AuthzService;
      const roles = options.roles ? options.roles.split(',') : undefined;
      await authz.runAs(SYSTEM, 'cli', () => create({ Email: options.email, Login: options.login, Password: options.password }, roles, SYSTEM));

      this.Log.success(options.password ? `User created` : `User created and invited to set a password`);
    } catch (e) {
      this.Log.error(`Error while creating user ${(e as Error).message}`);
    }
  }
}
