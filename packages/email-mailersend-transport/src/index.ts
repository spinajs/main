import { Autoinject, Injectable, NewInstance } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { Email, EmailSender, EmailConnectionOptions } from '@spinajs/email';
import { Templates } from '@spinajs/templates';
import { fs } from '@spinajs/fs';
import _ from 'lodash';

export interface MailerSendOptions {
  api_key: 'string';
}

/**
 * mailersend dont have typings ???
 */
const Recipient = require('mailersend').Recipient;
const EmailParams = require('mailersend').EmailParams;
const MailerSend = require('mailersend');

@Injectable()
@NewInstance()
export class MailersendTransport extends EmailSender {
  @Logger('email')
  protected Log: Log;

  @Autoinject(Templates)
  protected Tempates: Templates;

  @Autoinject(fs, (x) => x.Provider)
  protected FileSystems: Map<string, fs>;

  protected Connection: any;

  constructor(public Options: MailerSendOptions) {
    super();
  }

  public async resolve(): Promise<void> {
    this.Connection = new MailerSend({
      api_key: this.Options.api_key,
    });
  }

  public async send(email: Email): Promise<void> {
    const recipients = [new Recipient('your@client.com', 'Your Client')];
    const cc = [new Recipient('your_cc@client.com', 'Your CC Client')];
    const bcc = [new Recipient('your_bcc@client.com', 'Your BCC Client')];

    const emailParams = new EmailParams().setFrom('your@domain.com').setFromName('Your Name').setRecipients(recipients).setCc(cc).setBcc(bcc).setSubject('Subject').setHtml('This is the HTML content').setText('This is the text content');

    mailersend.send(emailParams);
  }
}
