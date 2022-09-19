import { QueueClient } from '@spinajs/Queue';
import { PasswordProvider, User } from '@spinajs/rbac';
import { Log, Logger } from '@spinajs/log';
import { CliCommand, Command, Option } from '@spinajs/cli';
import { AutoinjectService } from '@spinajs/configuration';
import { DateTime } from 'luxon';
import { Autoinject } from '@spinajs/di';
import { v4 as uuidv4 } from 'uuid';
import { NewUserMessage } from '../messages/NewUser';

interface UserCreationOptions {
  email: string;
  roles: string;
  login: string;
  password: string;
}

@Command('rbas:user-create', 'Creates user with given credentials')
@Option('-e, --email <email>', true, 'user email')
@Option('-r, --roles <roles>', true, 'user roles, comma separated')
@Option('-l, --login <login>', true, 'user login')
@Option('-p, --password <password>', false, 'user password, if not set will be generated and printed out to console')
export class CreateUser extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  @AutoinjectService('rbac.password.provider')
  protected PasswordProvider: PasswordProvider;

  @Autoinject(QueueClient)
  protected Queue: QueueClient;

  public async execute(options: UserCreationOptions): Promise<void> {
    const user = new User({
      Email: options.email,
      Login: options.login,
      Role: options.roles,
      IsBanned: false,
      IsActive: false,
    });

    if (options.password) {
      user.Password = await this.PasswordProvider.hash(options.password);
    } else {
      const pwd = await this.PasswordProvider.generate();
      user.Password = await this.PasswordProvider.hash(pwd);
      this.Log.warn(`USER PASSWORD: ${pwd}`);
    }

    user.IsBanned = false;
    user.IsActive = false;
    user.RegisteredAt = DateTime.now();
    user.Uuid = uuidv4();

    await user.insert();

    // notify others about user creation
    this.Queue.dispatch(new NewUserMessage(user, 'rbac:user:new'));

    this.Log.success('User creation SUCCESS');
  }
}
