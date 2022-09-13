import { CliCommand, Command, Option } from '@spinajs/cli';
import { DI } from '@spinajs/di';
import * as fs from 'fs';
import { Logger, ILog } from '@spinajs/log';
import { Emails } from './../index';

interface EmailOptions {
  connection: string;
  from: string;
  to: string;
  template?: string;
  model?: string;
  subject: string;
  content?: string;
}

@Command('email-send', 'Sends email, mainly for testing purpose or scheduled tasks')
@Option('-c, --connection [connection]', true, 'name of connection')
@Option('-f, --from [from]', true, 'from email')
@Option('-t, --to [to]', true, 'receipients, can be many ( comma separated )')
@Option('-e, --template [template]', false, 'template name')
@Option('-m, --model [model]', false, 'path to model data for template, in json format')
@Option('-s, --subject [model]', true, 'subject')
@Option('-c, --content [content]', false, 'text content if template is not provided')
export class SendEmailCommand extends CliCommand {
  @Logger('templates')
  protected Log: ILog;

  public async execute(options: EmailOptions): Promise<void> {
    this.Log.trace(`Sending email with options options: ${JSON.stringify(options)}`);

    try {
      const emails = await DI.resolve(Emails);
      let model = {};

      if (options.model && fs.existsSync(options.model)) {
        this.Log.trace(`Found model file at ${options.model}, trying to load model data ... `);

        const mText = fs.readFileSync(options.model, { encoding: 'utf-8' });
        model = JSON.parse(mText);
      }

      await emails.send({
        from: options.from,
        to: [options.to],
        connection: options.connection,
        template: options.template,
        model: model,
        subject: options.subject,
        text: options.content,
      });

      this.Log.success(`Email send succesyfully to: ${options.to}, from: ${options.from}, subject: ${options.subject}`);
    } catch (err) {
      this.Log.error(`Cannot send email, reason: ${err.message}, stack: ${err.stack}`);
    }
  }
}
