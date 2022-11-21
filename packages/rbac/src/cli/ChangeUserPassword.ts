import { ResourceNotFound, InvalidArgument } from '@spinajs/exceptions';
import { QueueClient } from '@spinajs/Queue';
import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { User } from '../models/User';
import { PasswordProvider } from '../interfaces';
import { UserPasswordChanged } from '../events/UserPasswordChanged';
import { Config } from '@spinajs/configuration';

@Command('rbac:user-ban', 'Sets active or inactive user')
@Argument('idOrUuid', 'numeric id or uuid')
@Argument('newPassword', 'new password')
export class ChangeUserPassword extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  @Autoinject(QueueClient)
  protected Queue: QueueClient;

  @Autoinject()
  protected PasswordProvider: PasswordProvider;

  @Config('rbac.user.minPasswordLength')
  protected MinPasswordLength: number;

  @Config('rbac.user.maxPasswordLength')
  protected MaxPasswordLength: number;

  public async execute(idOrUuid: string, newPassword: string): Promise<void> {
    const user = await User.where('Id', idOrUuid)
      .orWhere('Uuid', idOrUuid)
      .firstOrThrow(new ResourceNotFound(`No user with id ${idOrUuid} found`));

    if (newPassword.length < this.MinPasswordLength) {
      throw new InvalidArgument(`Password is less than ${this.MinPasswordLength} characters`);
    }

    if (newPassword.length > this.MaxPasswordLength) {
      throw new InvalidArgument(`Password is more than ${this.MinPasswordLength} characters`);
    }

    const hashedPassword = await this.PasswordProvider.hash(newPassword);
    user.Password = hashedPassword;
    await user.update();

    await this.Queue.emit(new UserPasswordChanged(idOrUuid));

    this.Log.success(`User password changed !`);
  }
}
