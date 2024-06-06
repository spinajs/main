import { Log, Logger } from '@spinajs/log';
import { CliCommand, Command, Option } from '@spinajs/cli';
import { create } from '../actions.js';

interface UserCreationOptions {
  email: string;
  roles: string;
  login: string;
  password: string;
}

@Command('rbac:user-create', 'Creates user with given credentials')
@Option('-e, --email <email>', true, 'user email')
@Option('-r, --roles <roles>', true, 'user roles, comma separated')
@Option('-l, --login <login>', true, 'user login')
@Option('-p, --password <password>', false, 'user password, if not set will be generated and printed out to console')
export class CreateUser extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  public async execute(options: UserCreationOptions): Promise<void> {
    try {
      await create(options.email, options.login, options.password, options.roles.split(","));
      this.Log.success(`User created`);
    } catch (e) {
      this.Log.error(`Error while creating user ${e.message}`);
    }
  }
}
