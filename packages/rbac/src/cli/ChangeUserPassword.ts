import { ResourceNotFound, InvalidArgument } from '@spinajs/exceptions';
import { QueueService } from '@spinajs/Queue';
import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { User } from '../models/User.js';
import { PasswordProvider, PasswordValidationProvider } from '../interfaces.js';
import { UserPasswordChanged } from '../events/UserPasswordChanged.js';
import { AutoinjectService } from '@spinajs/configuration';

@Command('rbac:user-change-password', 'Sets active or inactive user')
@Argument('idOrUuid', 'numeric id or uuid')
@Argument('newPassword', 'new password')
export class ChangeUserPassword extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  @Autoinject(QueueService)
  protected Queue: QueueService;

  @AutoinjectService('rbac.password')
  protected PasswordProvider: PasswordProvider;

  @AutoinjectService('rbac.validation')
  protected PasswordValidation: PasswordValidationProvider;

  public async execute(idOrUuid: string, newPassword: string): Promise<void> {
    const user = await User.where('Id', idOrUuid)
      .orWhere('Uuid', idOrUuid)
      .firstOrThrow(new ResourceNotFound(`No user with id ${idOrUuid} found`));

    if (!this.PasswordValidation.check(newPassword)) {
      throw new InvalidArgument(`New password does not match password rules, change passowrd or check rbac.password.validation config entry for password rules`);
    }

    const hashedPassword = await this.PasswordProvider.hash(newPassword);
    user.Password = hashedPassword;
    await user.update();

    await this.Queue.emit(new UserPasswordChanged(idOrUuid));

    this.Log.success(`User password changed !`);
  }
}
