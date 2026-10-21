# Password mails

`EmailPasswordMailer` sends the password reset and account invite mails of `@spinajs/authn-local` through `EmailService.send()`. Every mail is an MJML template: the mailer builds the `IEmail` (template, model, subject, redaction list) and the transport renders it through `@spinajs/templates`, where the `.mjml` extension selects `MjmlRenderer` from `@spinajs/templates-mjml` (handlebars, then `mjml2html`). It sends at once, never queues, and marks the secret and the reset link for [redaction](07-secret-redaction.md), so neither reaches a queue, the `EmailSent` event, a log or an error.

The queue is used one step earlier: with `authn.local.mail.delivery: 'queue'` an `AuthnMailJob` that holds no secret waits in the queue, and the consumer calls this mailer when it runs ([Mail delivery](../authn-local/13-mail-delivery.md)).

It is **not** registered by this package. `@spinajs/users` registers it as authn-local's `PasswordMailer` unless the app registered its own.

## How it works

1. `@spinajs/authn-local` issues a single-use secret when it delivers the mail and calls `PasswordMailer.send(mail)` with an `IPasswordMail`.
2. `EmailPasswordMailer.send(mail)` throws when `mail.to.email` is missing.
3. With a non-empty `mail.url`, it builds the link: `mail.url` with the query parameters `token=<secret>` and `email=<address>`, which the redemption page reads.
4. `compose()` builds the `IEmail`:
   - `connection`: `email.password.connection`, else `email.defaultConnection`; neither set throws `InvalidOperation`;
   - `subject`: `email.password.<purpose>.subject`, else `Reset your password` or `Set up your account`;
   - `tag`: `authn-password-reset` or `authn-password-invite`;
   - `template`: `email.password.<purpose>.template`, by default the built-in `authn/<purpose>.mjml`; `text` is never set;
   - `model`: see [Template model](#template-model);
   - `redact`: the secret and the link;
   - `from` from `email.password`, and `lang` from the mail or else `email.password.lang`, when set.
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
| `lang` | `string`, optional | Template language; overrides `email.password.lang`. |

## Templates

| Purpose | Built-in file | Filesystem | Default subject |
| --- | --- | --- | --- |
| `reset` | `authn/reset.mjml` | `email-builtin-templates` | `Reset your password` |
| `invite` | `authn/invite.mjml` | `email-builtin-templates` | `Set up your account` |
| `verify` | `authn/verify.mjml` | `email-builtin-templates` | `Confirm your email address` |

The files ship in the package under `lib/templates/authn/`. The package config registers the `fsNative` provider `email-builtin-templates` over `node_modules/@spinajs/email/lib/templates` (from `WORKSPACE_ROOT_PATH` or `cwd`). Each file is self-contained (no `mj-include`): a header with `AppName`, a button and a plain-link line bound to `ActionUrl`, the lifetime, and a footer that says to ignore an unexpected mail. Without a link the token takes the place of the button.

### Template model

| Variable | Type | Value |
| --- | --- | --- |
| `Purpose` | `string` | `reset`, `invite` or `verify`. |
| `Subject` | `string` | The mail subject. |
| `Name` | `string` | Recipient display name, or `''`. |
| `Email` | `string` | Recipient address. |
| `ActionUrl` | `string` | The redemption link with the secret, or `''` when `authn.local.reset.url` (`authn.local.verify.url` for `verify`) is empty. |
| `ResetUrl` | `string` | The same as `ActionUrl`, for templates written against 3.0. |
| `Token` | `string` | The raw secret, for apps without a redemption page. |
| `ExpiresInMinutes` | `number` | Secret lifetime in minutes, rounded. |
| `AppName` | `string` | `email.password.appName`, else `app.name`. |
| `IsInvite` | `boolean` | `true` for an invite. |

Write values with `{{Name}}` and blocks with `{{#if ActionUrl}}...{{else}}...{{/if}}`: `MjmlRenderer` runs handlebars before `mjml2html`, and handlebars escapes every `{{value}}` for HTML. The renderer also receives `lang`, so a localized override can pick its texts.

### Override one template

Copy the built-in file into your app's template filesystem, edit it, and point the purpose at it. The other purpose keeps its built-in file.

```ts
// config/email.ts in your app
export default {
  email: {
    templateFs: 'email-templates',
    password: {
      appName: 'Acme',
      reset: { subject: 'Reset your Acme password', template: 'acme/reset.mjml' },
      // or a file in another filesystem:
      invite: { template: { file: 'invite.mjml', fs: 'mail-templates' } },
    },
  },
};
```

A `template` must be a non-empty `.mjml` path, or `{ file, fs }` with an `.mjml` file and a filesystem name. Anything else (`null`, `''`, a `.pug` or `.hbs` file) fails the configuration validation at boot.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `email.password.connection` | `string` | `email.defaultConnection` | a connection name | Connection for both mails. |
| `email.password.from` | `string` | connection's `defaults.mailFrom` (SMTP) | address | Sender. |
| `email.password.lang` | `string` | not set | locale | Template language. |
| `email.password.appName` | `string` | `app.name` | | `AppName` in the templates. |
| `email.password.reset.subject` | `string` | `'Reset your password'` | | Reset mail subject. |
| `email.password.reset.template` | `string \| { file, fs }` | `{ file: 'authn/reset.mjml', fs: 'email-builtin-templates' }` | an `.mjml` file | Reset mail template. |
| `email.password.invite.subject` | `string` | `'Set up your account'` | | Invite mail subject. |
| `email.password.invite.template` | `string \| { file, fs }` | `{ file: 'authn/invite.mjml', fs: 'email-builtin-templates' }` | an `.mjml` file | Invite mail template. |
| `email.password.verify.subject` | `string` | `'Confirm your email address'` | | Address verification mail subject. |
| `email.password.verify.template` | `string \| { file, fs }` | `{ file: 'authn/verify.mjml', fs: 'email-builtin-templates' }` | an `.mjml` file | Address verification mail template. |
| `email.defaultConnection` | `string` | not set | a connection name | Fallback connection. |

```ts
// config/email.ts in your app
export default {
  email: {
    defaultConnection: 'main',
    password: {
      from: 'Acme Security <security@acme.com>',
      lang: 'pl',
      reset: { subject: 'Zmień hasło', template: 'pl/password-reset.mjml' },
      invite: { subject: 'Witamy w Acme', template: { file: 'invite.mjml', fs: 'mail-templates' } },
    },
  },
};
```

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
- **HTML only.** There is no plain-text body: every mail is the rendered MJML template. The built-in texts are English; override the templates for any other language.
- **The transport renders.** `EmailSenderSmtp` loads the file from its filesystem and calls `Templates.render()`; importing `@spinajs/email` registers `MjmlRenderer`. A transport that renders nothing (`BlackHoleEmailSender`) sends no body.
- **Errors never carry the secret**, and have no `cause`.
- **Template filesystems should have no `authz.fs` entry.** Inline reset and invite mails run without a user, so a guarded template read is refused; `AuthnMailJob` runs as the system principal.

## Best practices

- Set `email.password.connection` to a transactional connection, separate from bulk mail, so a throttled bulk sender does not delay resets.
- Use the shipped model names in templates (`ActionUrl`, `ExpiresInMinutes`); add new values through a `compose()` override.
- Start an override from the built-in file: it already handles the missing link and the escaping.

## Related

- [Secret redaction](07-secret-redaction.md): how `redact` protects the secret.
- [Replacing or extending `EmailService`](03-email-service.md): the service the mailer sends through.
- [`@spinajs/users`](../users/README.md): registers this mailer.
- [`@spinajs/authn`](../authn/README.md): local password login, which issues the secrets.
