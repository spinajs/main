import { CliCommand, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log-common';
import { EmailService } from './../index.js';

@Command('email-server', 'Starts email server ( processing emails sent to email queue )')
export class EmailServer extends CliCommand {
  @Logger('email')
  protected Log: Log;

  @Autoinject()
  protected EmailService: EmailService;

  public async execute(): Promise<void> {
    await this.EmailService.processDefferedEmails();
  }
}