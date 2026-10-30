import { DI } from '@spinajs/di';
import { MAILER, SETTINGS, MANIFEST_LIKE } from './tokens.js';
import { RENAMED_MAILER } from './reexport.js';

export class SmtpMailer {
  public send(): void {}
}

export class OtherMailer {
  public send(): void {}
}

DI.register(SmtpMailer).asToken(MAILER);
DI.register(OtherMailer).asToken(RENAMED_MAILER).asSelf();
DI.register({ retries: 3 }).asToken(SETTINGS);
DI.register({ some: 1 }).asValue(MANIFEST_LIKE.key);
DI.register({ n: 1 }).asValue(SETTINGS.key);
