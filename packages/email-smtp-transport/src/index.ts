import { Autoinject, Injectable, NewInstance } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { Email, EmailSender, EmailConnectionOptions } from '@spinajs/email';
import { Templates } from '@spinajs/templates';
import * as nodemailer from 'nodemailer';
import _ from 'lodash';

@Injectable()
@NewInstance()
export class EmailSenderSmtp extends EmailSender {
  @Logger('email')
  protected Log: Log;

  @Autoinject(Templates)
  protected Tempates: Templates;

  protected Transporter: nodemailer.Transport;

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
    let message = await this.Transporter.sendMail({
      from: email.from, // sender address
      to: email.to.join(',s'), // list of receivers
      cc: email.cc ? email.cc.join(',') : null,
      bcc: email.bcc ? email.bcc.join(',') : null,
      replyTo: email.replyTo,
      subject: email.subject, // Subject line
      text: email.text, // plain text body
      html: email.template ? await this.Tempates.render(email.template, email.model, email.lang) : null,
    });

    const response = await this.Transporter.send(message);

    this.Log.trace(`Send email with data: ${JSON.stringify(_.pick(email, ['from', 'to', 'cc', 'bcc', 'replyTo', 'subject']))}, SMTP response: ${JSON.stringify(response)}`);
  }
}
