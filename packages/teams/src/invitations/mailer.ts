import { Config } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { EmailService, redactText } from '@spinajs/email';
import type { IEmail } from '@spinajs/email';
import { IOFail, InvalidOperation } from '@spinajs/exceptions';

import { InvitationMailer } from '../api.js';
import type { InvitationMail } from '../api.js';
import { TEAMS_DEFAULTS } from '../schema.js';

/** `teams.invitations` keys the mailer reads. */
export interface InvitationMailOptions {
  readonly template?: string;
  readonly subject?: string;
  /** The page that accepts; the token is added as `?token=`. */
  readonly url?: string;
  readonly connection?: string;
}

export interface EmailInvitationMailerDeps {
  readonly email: EmailService;
  readonly options?: InvitationMailOptions;
  readonly defaultConnection?: string;
}

function acceptUrl(base: string | undefined, token: string): string {
  if (!base) return '';
  const url = new URL(base);
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * Sends at once and never queues: the token is a secret, so it and the link go into `redact`, which keeps them out
 * of queued payloads, the EmailSent event, logs and errors.
 */
@Injectable(InvitationMailer)
export class EmailInvitationMailer extends InvitationMailer {
  @Config('teams.invitations', { defaultValue: {} })
  protected Options: InvitationMailOptions;

  @Config('email.defaultConnection')
  protected DefaultConnection: string;

  /** With `deps`, neither the configuration nor the container is used. */
  constructor(protected readonly Deps?: EmailInvitationMailerDeps) {
    super();
  }

  async send(mail: InvitationMail): Promise<void> {
    const options = (this.Deps ? this.Deps.options : this.Options) ?? {};
    const link = acceptUrl(options.url, mail.token);
    const secrets = link ? [mail.token, link] : [mail.token];
    try {
      const connection = options.connection || (this.Deps ? this.Deps.defaultConnection : this.DefaultConnection);
      if (!connection) throw new InvalidOperation('set teams.invitations.connection or email.defaultConnection');
      const service = this.Deps ? this.Deps.email : ((await DI.resolve(EmailService)) as EmailService);
      await service.send(this.compose(mail, options, connection, link, secrets));
    } catch (err) {
      // No cause: anything hanging off the original error may hold the token.
      throw new IOFail(`The invitation mail was not sent: ${redactText(err instanceof Error ? err.message : String(err), secrets)}`);
    }
  }

  protected compose(mail: InvitationMail, options: InvitationMailOptions, connection: string, link: string, secrets: readonly string[]): IEmail {
    const where = mail.group ? `${mail.team.name} / ${mail.group.name}` : mail.team.name;
    const text = [`You are invited to join ${where} as ${mail.role}.`, link ? `Accept the invitation:\n${link}` : `Your invitation code:\n${mail.token}`, `It expires at ${mail.expiresAt.toISOString()}.`].join('\n\n');
    return {
      to: [mail.to],
      connection,
      subject: options.subject || TEAMS_DEFAULTS.subject,
      tag: 'teams-invitation',
      model: { Team: mail.team.name, TeamSlug: mail.team.slug, Group: mail.group?.name ?? '', Role: mail.role, Token: mail.token, AcceptUrl: link, ExpiresAt: mail.expiresAt.toISOString(), Email: mail.to },
      redact: [...secrets],
      ...(options.template ? { template: options.template } : { text }),
    };
  }
}
