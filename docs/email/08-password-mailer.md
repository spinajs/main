# Password mails

`EmailPasswordMailer` sends the password reset and account invite mails of `@spinajs/authn-local` through `EmailService.send()`. It sends at once, never queues, and marks the secret and the reset link for [redaction](07-secret-redaction.md), so neither reaches a queue, the `EmailSent` event, a log or an error.

It is **not** registered by this package. `@spinajs/users` registers it as authn-local's `PasswordMailer` unless the app registered its own.

## How it works

1. `@spinajs/authn-local` issues a single-use secret and calls `PasswordMailer.send(mail)` with an `IPasswordMail`.
2. `EmailPasswordMailer.send(mail)` throws when `mail.to.email` is missing.
3. With a non-empty `mail.url`, it builds the link: `mail.url` with the query parameters `token=<secret>` and `email=<address>`, which the redemption page reads.
4. `compose()` builds the `IEmail`:
   - `connection`: `email.password.connection`, else `email.defaultConnection`; neither set throws `InvalidOperation`;
   - `subject`: `email.password.<purpose>.subject`, else `Reset your password` or `Set up your account`;
   - `tag`: `authn-password-reset` or `authn-password-invite`;
   - `model`: `Token`, `ResetUrl`, `ExpiresInMinutes`, `IsInvite`, `Name`, `Email`, `Purpose`;
   - `redact`: the secret and the link;
   - `from`, `lang` from `email.password` when set;
   - `template` from `email.password.<purpose>.template`, or else a short plain-text `text` body with the link (or the code when there is no link) and the lifetime in minutes.
5. It resolves `EmailService` from the root container (or uses `Deps.email`) and calls `send()`.
6. Any failure is rethrown as `IOFail` (`The <purpose> password mail was not sent: <message>`), with the secret and the link redacted and no cause.

### `IPasswordMail`

The fields of authn-local's `PasswordMail`, declared here so this package never imports authn-local.

| Field | Type | Meaning |
| --- | --- | --- |
| `identity` | `{ type: string; id: string }` | Who the mail is for. |
| `purpose` | `'reset' \| 'invite'` | Which mail. |
| `to` | `{ email?: string; name?: string }` | Recipient address and display name. |
| `secret` | `string` | The raw single-use secret. |
| `url` | `string` | Page that redeems the secret, or `''`. |
| `ttlSeconds` | `number` | Secret lifetime; shown rounded to minutes. |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `email.password.connection` | `string` | `email.defaultConnection` | a connection name | Connection for both mails. |
| `email.password.from` | `string` | connection's `defaults.mailFrom` (SMTP) | address | Sender. |
| `email.password.lang` | `string` | not set | locale | Template language. |
| `email.password.attachments` | `{ name, path, provider?, cid? }[]` | not set | | Sent with every reset and invite mail, as `IEmail.attachements`; the email service reads each through its filesystem (`provider`, else the default). Give an image a `cid` to show it inline (`<img src="cid:logo">`). |
| `email.password.reset.subject` | `string` | `'Reset your password'` | | Reset mail subject. |
| `email.password.reset.template` | `string \| { file, fs }` | not set (plain text) | | Reset mail template. |
| `email.password.invite.subject` | `string` | `'Set up your account'` | | Invite mail subject. |
| `email.password.invite.template` | `string \| { file, fs }` | not set (plain text) | | Invite mail template. |
| `email.defaultConnection` | `string` | not set | a connection name | Fallback connection. |

```ts
// config/email.ts in your app
export default {
  email: {
    defaultConnection: 'main',
    password: {
      from: 'Acme Security <security@acme.com>',
      lang: 'pl',
      reset: { subject: 'Zmień hasło', template: 'password-reset.pug' },
      invite: { subject: 'Witamy w Acme', template: { file: 'invite.pug', fs: 'mail-templates' } },
    },
  },
};
```

A template gets the model: `Token`, `ResetUrl`, `ExpiresInMinutes`, `IsInvite`, `Name`, `Email`, `Purpose`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Password mailer | `PasswordMailer` from `@spinajs/authn-local`, singleton; registered by the `@spinajs/users` bootstrapper only when nothing is registered yet | `EmailPasswordMailer` | your own `PasswordMailer` | Register yours before the users bootstrapper runs, or subclass `EmailPasswordMailer` and override `compose()`. |

### Construction modes

| Constructor | Reads config from | Sends through |
| --- | --- | --- |
| `new EmailPasswordMailer()` (as DI builds it) | `@Config('email.password')`, `@Config('email.defaultConnection')` | `DI.resolve(EmailService)` |
| `new EmailPasswordMailer({ email, options, defaultConnection })` | `options`, `defaultConnection` | `email` |

The `Deps` form needs no container; use it in unit tests and in code that holds its own `EmailService`.

### Register without `@spinajs/users`

```ts
import { DI } from '@spinajs/di';
import { PasswordMailer } from '@spinajs/authn-local';
import { EmailPasswordMailer } from '@spinajs/email';

DI.register(EmailPasswordMailer).as(PasswordMailer);
```

### Extend: add support details to every password mail

Override `compose()` and call `super.compose()`: you keep the redaction list, the tag and the connection rules.

```ts sample
import { EmailPasswordMailer, IEmail, IPasswordMail } from '@spinajs/email';

export class SupportedPasswordMailer extends EmailPasswordMailer {
  protected compose(mail: IPasswordMail, address: string, link: string, secrets: readonly string[]): IEmail {
    const email = super.compose(mail, address, link, secrets);

    return {
      ...email,
      replyTo: 'support@acme.com',
      model: { ...email.model, SupportPhone: '+48 22 100 20 30' },
    };
  }
}
```

Register it under authn-local's token in your app's startup code, which runs before the users bootstrapper:

```ts
DI.register(SupportedPasswordMailer).as(PasswordMailer);
```

### Use: send a reset mail without the container

```ts sample
import { EmailPasswordMailer, EmailService } from '@spinajs/email';

export async function sendReset(emails: EmailService, address: string, secret: string): Promise<void> {
  const mailer = new EmailPasswordMailer({
    email: emails,
    options: { connection: 'main', reset: { subject: 'Reset your Acme password' } },
  });

  await mailer.send({
    identity: { type: 'user', id: 'u-1042' },
    purpose: 'reset',
    to: { email: address, name: 'Anna' },
    secret,
    url: 'https://app.acme.com/password-reset',
    ttlSeconds: 3600,
  });
}
```

## Important behaviour

- **Never queued.** It calls `send()`, not `sendDeferred()`, so there is no queue retry: a send that fails after the transport's own retries fails the request.
- **The link format is fixed**: `token` and `email` query parameters; build the redemption page to read those two.
- **Plain-text fallback.** Without a template the body is a short English text; set a template for any other language.
- **Errors never carry the secret**, and have no `cause`.
- **Template filesystems should have no `authz.fs` entry.** Reset and invite mails run without a user, so a guarded template read is refused.

## Best practices

- Set `email.password.connection` to a transactional connection, separate from bulk mail, so a throttled bulk sender does not delay resets.
- Use the shipped model names in templates (`ResetUrl`, `ExpiresInMinutes`); add new values through a `compose()` override.

## Related

- [Secret redaction](07-secret-redaction.md): how `redact` protects the secret.
- [Replacing or extending `EmailService`](03-email-service.md): the service the mailer sends through.
- [`@spinajs/users`](../users/README.md): registers this mailer.
- [`@spinajs/authn`](../authn/README.md): local password login, which issues the secrets.
