import { DI } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation, IOFail } from '@spinajs/exceptions';
import { EmailService, IEmail, IEmailTemplate, PasswordMailConfiguration } from './interfaces.js';
import { redactText } from './redact.js';

/** `AuthnMailPurpose` of `@spinajs/authn-local`. */
export type PasswordMailPurpose = 'reset' | 'invite' | 'verify' | 'account-exists';

/** The fields of `PasswordMail` from `@spinajs/authn-local`, declared here so this package never imports it. */
export interface IPasswordMail {
  readonly identity: { readonly type: string; readonly id: string };
  readonly purpose: PasswordMailPurpose;
  readonly to: { readonly email?: string; readonly name?: string };
  /** The raw single-use secret. */
  readonly secret: string;
  /** The page that redeems the secret, or ''. */
  readonly url: string;
  readonly ttlSeconds: number;
  /** Overrides `email.password.lang`. */
  readonly lang?: string;
}

export interface EmailPasswordMailerDeps {
  readonly email: EmailService;
  /** `email.password` */
  readonly options?: PasswordMailConfiguration;
  /** `email.defaultConnection` */
  readonly defaultConnection?: string;
}

const DEFAULT_SUBJECTS: Readonly<Record<PasswordMailPurpose, string>> = { reset: 'Reset your password', invite: 'Set up your account', verify: 'Confirm your email address', 'account-exists': 'You already have an account' };

/** What the package config ships as `email.password.<purpose>.template`, for the `deps` seam and a config without it. */
const BUILTIN_TEMPLATES: Readonly<Record<PasswordMailPurpose, IEmailTemplate>> = {
  reset: { file: 'authn/reset.mjml', fs: 'email-builtin-templates' },
  invite: { file: 'authn/invite.mjml', fs: 'email-builtin-templates' },
  verify: { file: 'authn/verify.mjml', fs: 'email-builtin-templates' },
  'account-exists': { file: 'authn/account-exists.mjml', fs: 'email-builtin-templates' },
};

/** `base` with the `token` and `email` query parameters the redemption page reads. */
function resetUrl(base: string, secret: string, email: string): string {
  if (!base) {
    return '';
  }
  const url = new URL(base);
  url.searchParams.set('token', secret);
  url.searchParams.set('email', email);
  return url.toString();
}

/**
 * The `PasswordMailer` of `@spinajs/authn-local` over `EmailService.send`: it sends the `.mjml` template of the purpose at once,
 * never queues, and marks the secret and the link for redaction, so neither reaches a queued payload, the `EmailSent` event, a
 * log or an error (SR-09).
 *
 * Not registered here: importing authn-local registers local password login, which would switch it on in every app that sends
 * mail. `@spinajs/users` registers it as the `PasswordMailer` unless the app registered its own.
 */
export class EmailPasswordMailer {
  @Config('email.password', { defaultValue: {} })
  protected Options: PasswordMailConfiguration;

  @Config('email.defaultConnection')
  protected DefaultConnection: string;

  @Config('app.name', { defaultValue: '' })
  protected AppName: string;

  /** With `deps`, neither the configuration nor the container is used. */
  constructor(protected readonly Deps?: EmailPasswordMailerDeps) {}

  public async send(mail: IPasswordMail): Promise<void> {
    const secrets = mail.secret ? [mail.secret] : [];
    try {
      const address = mail.to.email;
      if (!address) {
        throw new InvalidArgument('the recipient has no email address');
      }
      // A mail without a secret links to the page as it is.
      const link = mail.secret ? resetUrl(mail.url, mail.secret, address) : mail.url;
      if (link && mail.secret) {
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
    const subject = purpose.subject || DEFAULT_SUBJECTS[mail.purpose];
    const lang = mail.lang || options.lang;

    return {
      to: [address],
      connection,
      subject,
      tag: `authn-password-${mail.purpose}`,
      template: purpose.template || { ...BUILTIN_TEMPLATES[mail.purpose] },
      model: {
        Purpose: mail.purpose,
        Subject: subject,
        Name: mail.to.name ?? '',
        Email: address,
        ActionUrl: link,
        // 3.0 templates read the link under this name.
        ResetUrl: link,
        Token: mail.secret,
        ExpiresInMinutes: Math.round(mail.ttlSeconds / 60),
        AppName: this.appName(options),
        IsInvite: mail.purpose === 'invite',
      },
      redact: [...secrets],
      ...(options.from ? { from: options.from } : {}),
      ...(lang ? { lang } : {}),
    };
  }

  private appName(options: PasswordMailConfiguration): string {
    return options.appName || (this.Deps ? '' : this.AppName) || '';
  }
}
