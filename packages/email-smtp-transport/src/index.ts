import { IOFail } from '@spinajs/exceptions';
import { Autoinject, DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { IEmail, EmailSender, EmailConnectionOptions, IEmailAttachement } from '@spinajs/email';
import { Templates } from '@spinajs/templates';
import * as nodemailer from 'nodemailer';
import { fs } from '@spinajs/fs';
import _ from 'lodash';
import { Config } from '@spinajs/configuration';

@Injectable(EmailSender)
@PerInstanceCheck()
export class EmailSenderSmtp extends EmailSender {
  @Logger('email')
  protected Log: Log;

  @Autoinject(Templates)
  protected Tempates: Templates;


  @Config('fs.defaultProvider')
  protected DefaultFileProvider: string;

  protected Transporter: nodemailer.Transporter;

  constructor(public Options: EmailConnectionOptions) {
    super();
  }

  public async resolve(): Promise<void> {
    const options = Object.assign(
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
    );

    this.Log.info(`Creating connection to smtp: ${options.auth.user}@${options.host}:${options.port}, secure: ${options.secure}`)

    // create reusable transporter object using the default SMTP transport
    this.Transporter = nodemailer.createTransport(options);

    try {
      // verify returns Promise<true> so always is true
      // we must catch exception
      await this.Transporter.verify();
    } catch (err) {
      throw new Error(`cannot send smtp emails, verify() failed. Please check email smtp configuration for connection ${this.Options.name}`);
    }

    this.Log.success(`Email smtp connection ${this.Options.name} on host ${this.Options.host} established !`);
  }

  public async send(email: IEmail): Promise<void> {
    if (!email.from && !this.Options.defaults?.mailFrom) {
      throw new IOFail(`Email from address is required. Please provide it in email or in configuration`);
    }

    const options = {
      from: email.from ?? this.Options.defaults?.mailFrom, // sender address
      to: email.to.join(','), // list of receivers
      cc: email.cc ? email.cc.join(',') : null,
      bcc: email.bcc ? email.bcc.join(',') : null,
      replyTo: email.replyTo,
      subject: email.subject, // Subject line
      text: email.text, // plain text body
      html: email.template ? await this.Tempates.render(email.template, { ...email.model, ...this.Options.templates?.defaults }, email.lang) : null,
      attachments: [] as any[],
    };

    if (email.attachements) {
      options.attachments = await Promise.all(
        email.attachements.map(async (a: IEmailAttachement) => {
          // we allow to use multiple file sources, default is local

          const provider = await DI.resolve<fs>('__file_provider__', [a.provider || this.DefaultFileProvider]);
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
            cid: a.cid,
            filename: a.name,
            path: file,
            provider: provider.Name,
          };
        }),
      );
    }

    let message = await this.Transporter.sendMail(options);

    this.Log.trace(`Sent email with data: ${JSON.stringify(_.pick(email, ['from', 'to', 'cc', 'bcc', 'replyTo', 'subject']))}, SMTP response: ${JSON.stringify(message)}`);
  }
}
