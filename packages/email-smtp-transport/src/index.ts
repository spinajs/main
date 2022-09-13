import { IOFail } from '@spinajs/exceptions';
import { Autoinject, Bootstrapper, DI, Injectable, NewInstance } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { Email, EmailSender, EmailConnectionOptions } from '@spinajs/email';
import { Templates } from '@spinajs/templates';
import * as nodemailer from 'nodemailer';
import { fs } from '@spinajs/fs';
import _ from 'lodash';
import CONFIGURATION_SCHEMA from "./schemas/email.configuration";

@Injectable(Bootstrapper)
export class LogBotstrapper extends Bootstrapper {
  public bootstrap(): void {
    DI.register(CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  }
}

@Injectable()
@NewInstance()
export class EmailSenderSmtp extends EmailSender {
  @Logger('email')
  protected Log: Log;

  @Autoinject(Templates)
  protected Tempates: Templates;

  @Autoinject(fs, (x) => x.Provider)
  protected FileSystems: Map<string, fs>;

  protected Transporter: nodemailer.Transporter;

  constructor(public Options: EmailConnectionOptions) {
    super();
  }

  public async resolveAsync(): Promise<void> {
    // create reusable transporter object using the default SMTP transport
    this.Transporter = nodemailer.createTransport(
      Object.assign(
        {
          host: this.Options.host,
          port: this.Options.port,
          secure: this.Options.ssl, // true for 465, false for other ports
          auth: {
            user: this.Options.login, // generated ethereal user
            pass: this.Options.password, // generated ethereal password
          },
        },

        // all additional options merged
        this.Options.options,
      ),
    );
  }

  public async send(email: Email): Promise<void> {
    const options = {
      from: email.from, // sender address
      to: email.to.join(','), // list of receivers
      cc: email.cc ? email.cc.join(',') : null,
      bcc: email.bcc ? email.bcc.join(',') : null,
      replyTo: email.replyTo,
      subject: email.subject, // Subject line
      text: email.text, // plain text body
      html: email.template ? await this.Tempates.render(email.template, email.model, email.lang) : null,
      attachments: await Promise.all(
        email.attachements.map(async (a) => {
          // we allow to use multiple file sources, default is local
          const provider = this.FileSystems.get(a.provider ?? 'fs-local');
          if (!provider) {
            throw new IOFail(`Filesystem privider for ${a.provider} not registered. Make sure you importer all required fs providers`);
          }

          // with local filesystem, it just return original path
          // other implementations should dodwnload file locally,
          // and return temporary path
          // we provide path to file, becouse nodemailer
          // prefer it when sending bigger files
          const file = await provider.download(a.path);
          return {
            filename: a.name,
            path: file,
            provider: provider.Provider,
          };
        }),
      ),
    };

    let message = await this.Transporter.sendMail(options);

    // delete all downloaded files for attachement
    // all non local files are downloaded
    // and temporary path is in email attachement path property
    const fsLocal = this.FileSystems.get('fs-local');
    await Promise.all(options.attachments.filter((x) => x.provider !== 'fs-local').map((x) => fsLocal.unlink(x.path)));

    this.Log.trace(`Sent email with data: ${JSON.stringify(_.pick(email, ['from', 'to', 'cc', 'bcc', 'replyTo', 'subject']))}, SMTP response: ${JSON.stringify(message)}`);
  }
}
