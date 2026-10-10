import { DI } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation, IOFail } from '@spinajs/exceptions';
import { EmailService, IEmail, PasswordMailConfiguration } from './interfaces.js';
import { redactText } from './redact.js';

/** The fields of `PasswordMail` from `@spinajs/authn-local`, declared here so this package never imports it. */
export interface IPasswordMail {
  readonly identity: { readonly type: string; readonly id: string };
  readonly purpose: 'reset' | 'invite';
  readonly to: { readonly email?: string; readonly name?: string };
  /** The raw single-use secret. */
  readonly secret: string;
  /** The page that redeems the secret, or ''. */
  readonly url: string;
  readonly ttlSeconds: number;
}

export interface EmailPasswordMailerDeps {
  readonly email: EmailService;
  /** `email.password` */
  readonly options?: PasswordMailConfiguration;
  /** `email.defaultConnection` */
  readonly defaultConnection?: string;
}

const DEFAULT_SUBJECTS = { reset: 'Reset your password', invite: 'Set up your account' } as const;

/** As 2.x `passwordResetUrl` builds it, so 2.x redemption pages keep working. */
function resetUrl(base: string, secret: string, email: string): string {
  if (!base) {
    return '';
  }
  const url = new URL(base);
  url.searchParams.set('token', secret);
  url.searchParams.set('email', email);
  return url.toString();
}

function plainText(purpose: IPasswordMail['purpose'], link: string, secret: string, minutes: number): string {
  const intro = purpose === 'invite' ? 'An account was created for you. Set its password to start using it.' : 'We received a request to reset your password.';
  const action = link ? `Open this link to set a new password:\n${link}` : `Use this code to set a new password:\n${secret}`;
  const outro = purpose === 'invite' ? `It expires in ${minutes} minutes.` : `It expires in ${minutes} minutes. If you did not ask for it, ignore this mail.`;
  return [intro, action, outro].join('\n\n');
}

/**
 * The `PasswordMailer` of `@spinajs/authn-local` over `EmailService.send`: it renders and sends at once, never queues, and marks
 * the secret and the link for redaction, so neither reaches a queued payload, the `EmailSent` event, a log or an error (SR-09).
 *
 * Not registered here: importing authn-local registers local password login, which would switch it on in every app that sends
 * mail. `@spinajs/users` registers it as the `PasswordMailer` unless the app registered its own.
 */
export class EmailPasswordMailer {
  @Config('email.password', { defaultValue: {} })
  protected Options: PasswordMailConfiguration;

  @Config('email.defaultConnection')
  protected DefaultConnection: string;

  /** With `deps`, neither the configuration nor the container is used. */
  constructor(protected readonly Deps?: EmailPasswordMailerDeps) {}

  public async send(mail: IPasswordMail): Promise<void> {
    const secrets = [mail.secret];
    try {
      const address = mail.to.email;
      if (!address) {
        throw new InvalidArgument('the recipient has no email address');
      }
      const link = resetUrl(mail.url, mail.secret, address);
      if (link) {
        secrets.push(link);
      }
      const email = this.compose(mail, address, link, secrets);
      const service = this.Deps ? this.Deps.email : await DI.resolve(EmailService);
      await service.send(email);
    } catch (err) {
      // No cause: anything hanging off the original error may hold the secret, not only its message.
      throw new IOFail(`The ${mail.purpose} password mail was not sent: ${redactText(err instanceof Error ? err.message : String(err), secrets)}`);
    }
  }

  protected compose(mail: IPasswordMail, address: string, link: string, secrets: readonly string[]): IEmail {
    const options = (this.Deps ? this.Deps.options : this.Options) ?? {};
    const connection = options.connection || (this.Deps ? this.Deps.defaultConnection : this.DefaultConnection);
    if (!connection) {
      throw new InvalidOperation('set email.password.connection or email.defaultConnection');
    }
    const purpose = options[mail.purpose] ?? {};
    const minutes = Math.round(mail.ttlSeconds / 60);

    return {
      to: [address],
      connection,
      subject: purpose.subject || DEFAULT_SUBJECTS[mail.purpose],
      tag: `authn-password-${mail.purpose}`,
      // 2.x model names, so 2.x templates keep working.
      model: {
        Token: mail.secret,
        ResetUrl: link,
        ExpiresInMinutes: minutes,
        IsInvite: mail.purpose === 'invite',
        Name: mail.to.name ?? '',
        Email: address,
        Purpose: mail.purpose,
      },
      redact: [...secrets],
      ...(options.from ? { from: options.from } : {}),
      ...(options.lang ? { lang: options.lang } : {}),
      ...(purpose.template ? { template: purpose.template } : { text: plainText(mail.purpose, link, mail.secret, minutes) }),
    };
  }
}
