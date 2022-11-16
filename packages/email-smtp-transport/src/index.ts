import { IInstanceCheck } from './../../di/src/interfaces';
import { IOFail } from '@spinajs/exceptions';
import { Autoinject, Injectable, PerInstanceCheck } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { IEmail, EmailSender, EmailConnectionOptions } from '@spinajs/email';
import { Templates } from '@spinajs/templates';
import * as nodemailer from 'nodemailer';
import { fs } from '@spinajs/fs';
import _ from 'lodash';
import { AutoinjectService, Config } from '@spinajs/configuration';

@Injectable(EmailSender)
@PerInstanceCheck()
export class EmailSenderSmtp extends EmailSender implements IInstanceCheck {
  @Logger('email')
  protected Log: Log;

  @Autoinject(Templates)
  protected Tempates: Templates;

  @AutoinjectService('fs.providers', fs)
  protected FileSystems: Map<string, fs>;

  @Config('fs.default')
  protected DefaultFileProvider: string;

  protected Transporter: nodemailer.Transporter;

  public get Name(): string {
    return this.Options.name;
  }

  constructor(public Options: EmailConnectionOptions) {
    super();
  }

  public __checkInstance__(creationOptions: any): boolean {
    return this.Name === creationOptions[0].name;
  }

  public async resolve(): Promise<void> {
    // create reusable transporter object using the default SMTP transport
    this.Transporter = nodemailer.createTransport(
      Object.assign(
        {
          host: this.Options.host,
          port: this.Options.port,
          secure: this.Options.ssl, // true for 465, false for other ports
          auth: {
            user: this.Options.user, // generated ethereal user
            pass: this.Options.pass, // generated ethereal password
          },
        },

        // all additional options merged
        this.Options.options,
      ),
    );

    const result = await this.Transporter.verify();
    if (!result) {
      throw new Error(`cannot send smtp emails, varify() failed. Pleas check email smtp configuration for connection ${this.Options.name}`);
    }

    this.Log.success(`Email smtp connection ${this.Options.name} on host ${this.Options.host} established !`);
  }

  public async send(email: IEmail): Promise<void> {
    const options = {
      from: email.from, // sender address
      to: email.to.join(','), // list of receivers
      cc: email.cc ? email.cc.join(',') : null,
      bcc: email.bcc ? email.bcc.join(',') : null,
      replyTo: email.replyTo,
      subject: email.subject, // Subject line
      text: email.text, // plain text body
      html: email.template ? await this.Tempates.render(email.template, email.model, email.lang) : null,
      attachments: [] as any[],
    };

    if (email.attachements) {
      options.attachments = await Promise.all(
        email.attachements.map(async (a: any) => {
          // we allow to use multiple file sources, default is local
          const provider = this.FileSystems.get(a.provider ?? this.DefaultFileProvider);
          if (!provider) {
            throw new IOFail(`Filesystem provider for ${a.provider} not registered. Make sure you importer all required fs providers`);
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
            provider: provider.Name,
          };
        }),
      );
    }

    let message = await this.Transporter.sendMail(options);

    // delete all downloaded files for attachement
    // all non local files are downloaded
    // and temporary path is in email attachement path property
    const fsLocal = this.FileSystems.get('fs-local');
    await Promise.all(options.attachments.filter((x: any) => x.provider !== 'fs-local').map((x: any) => fsLocal.unlink(x.path)));

    this.Log.trace(`Sent email with data: ${JSON.stringify(_.pick(email, ['from', 'to', 'cc', 'bcc', 'replyTo', 'subject']))}, SMTP response: ${JSON.stringify(message)}`);
  }
}
