import { Log, Logger } from '@spinajs/log';
import { Option, CliCommand, Command } from '@spinajs/cli';
import { User } from '../models/User';

interface UserOption {
  idOrUuid?: string;
  login?: string;
  email?: string;
}

@Command('rbac:user-active', 'Sets active or inactive user')
@Option('-i, --idOrUuid <idOrUuid>', false, 'numeric id or uuid')
@Option('-l, --login <login>', false, 'login')
@Option('-e, --email <email>', false, 'email')
export class CreateUser extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  public async execute(options: UserOption): Promise<void> {
    let query = null;

    if (options.email) {
      query = User.where('Email', 'like', `%${options.email}`);
    }

    if (options.login) {
      query = User.where('Login', 'like', `%${options.login}`);
    }

    if (options.idOrUuid) {
      query = User.where('Id', options.idOrUuid).orWhere('Uuid', options.idOrUuid);
    }

    const user = await query;

    user.forEach((x) => {
      this.Log.info(`User : ${x.Id}, ${x.Uuid}, email: ${x.Email}, login: ${x.Login}, active: ${x.IsActive}, banned: ${x.IsBanned}, CreatedAt: ${x.CreatedAt.toISO()}`);
    });
  }
}
