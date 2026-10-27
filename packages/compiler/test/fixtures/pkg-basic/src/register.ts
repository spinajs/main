import { DI } from '@spinajs/di';
import { Mailer } from './services.js';

export class LogMailer extends Mailer {}
export class NullMailer extends Mailer {}

DI.register(LogMailer).as(Mailer);
DI.register(NullMailer).asSelf().singleInstance();
