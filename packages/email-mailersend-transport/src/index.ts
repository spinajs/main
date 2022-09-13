import { Autoinject, Injectable, NewInstance } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { Email, EmailSender, EmailConnectionOptions } from '@spinajs/email';
import { Templates } from '@spinajs/templates';
import { fs } from '@spinajs/fs';
import _ from 'lodash';

@Injectable()
@NewInstance()
export class MailersendTransport extends EmailSender {
  @Logger('email')
  protected Log: Log;

  @Autoinject(Templates)
  protected Tempates: Templates;

  @Autoinject(fs, (x) => x.Provider)
  protected FileSystems: Map<string, fs>;

  constructor(public Options: EmailConnectionOptions) {
    super();
  }

  public async resolveAsync(): Promise<void> {}

  public async send(email: Email): Promise<void> {
     
