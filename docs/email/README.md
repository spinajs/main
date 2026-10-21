# `@spinajs/email`

Sends email through named connections, at once or through the queue. The package owns the sending pipeline: connection lookup, attachment reads, recipient redirection, secret redaction, metrics, the `EmailSent` and `EmailSendFailed` events, and the deferred `EmailSend` job.

It does **not** talk SMTP and does **not** render templates. A transport does both: install [`@spinajs/email-smtp-transport`](../email-smtp-transport/README.md) or write your own `EmailSender`. The only transports shipped here are black holes.

## Install

```sh
npm install @spinajs/email
```

Add a transport for real mail:

```sh
npm install @spinajs/email-smtp-transport
```

## Features

| Feature | What it does |
| --- | --- |
| [Sending email](01-sending-email.md) | `EmailService.send()`, the `IEmail` shape, connections config, the send pipeline and the `EmailSent` event. |
| [Transports (`EmailSender`)](02-transports.md) | One `EmailSender` per configured connection, picked by class name; write and register your own transport. |
| [Replacing or extending `EmailService`](03-email-service.md) | The `EmailService` DI token, `DefaultEmailService` and its overridable steps. |
| [Deferred sending](04-deferred-sending.md) | `sendDeferred()`, the `EmailSend` job, retry, schedules, `EmailSendFailed`, the `email-server` worker. |
| [Attachments](05-attachments.md) | Attachments read through `@spinajs/fs` as the sending principal before the transport runs. |
| [Recipient redirect](06-recipient-redirect.md) | `redirectTo` sends every mail of a dev or staging connection to a test inbox; refused on production. |
| [Secret redaction](07-secret-redaction.md) | `IEmail.redact` keeps reset tokens and links out of the queue, events, logs and errors. |
| [Password mails](08-password-mailer.md) | `EmailPasswordMailer` sends `@spinajs/authn-local` reset and invite mails from built-in MJML templates a project can replace. |
| [CLI commands](09-cli-commands.md) | `email-send` and `email-server`. |

## Quick start

Configure a connection (here with the SMTP transport):

```ts
// config/email.ts in your app
export default {
  email: {
    defaultConnection: 'main',
    connections: [
      {
        name: 'main',
        service: 'EmailSenderSmtp',
        host: 'smtp.acme.com',
        port: 587,
        user: 'billing@acme.com',
        password: process.env.SMTP_PASSWORD,
        defaults: { mailFrom: 'Acme Billing <billing@acme.com>' },
      },
    ],
  },
};
```

Send a mail:

```ts sample
import { DI } from '@spinajs/di';
import { EmailService } from '@spinajs/email';

export async function sendInvoiceNotice(customer: string, invoiceNo: string): Promise<void> {
  const emails = await DI.resolve(EmailService);

  await emails.send({
    connection: 'main',
    to: [customer],
    subject: `Invoice ${invoiceNo}`,
    text: `Your invoice ${invoiceNo} is ready in the customer portal.`,
    tag: 'billing',
  });
}
```

## Extension points at a glance

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Email service | `EmailService`, singleton | `DefaultEmailService` | your subclass | `DI.register(MyService).as(EmailService)`; see [03](03-email-service.md) |
| Transport per connection | `EmailSender`, new instance per connection entry, picked by class name in `email.connections[].service` | none configured | `BlackHoleEmailSender`, `EmailSenderSmtp` ([`email-smtp-transport`](../email-smtp-transport/README.md)) | `@Injectable(EmailSender) @NewInstance()` class; see [02](02-transports.md) |
| Password mailer | not registered here; `@spinajs/users` registers it as `PasswordMailer` | `EmailPasswordMailer` | your `PasswordMailer` | subclass and override `compose()`; see [08](08-password-mailer.md) |
| Sent and failed events | queue events `EmailSent`, `EmailSendFailed` | routed to a black-hole queue | any queue connection | `queue.routing` plus `QueueService.consume()`; see [04](04-deferred-sending.md) |
| Config schema bootstrapper | `Bootstrapper`, `EmailBootstrapper` (`LogBotstrapper` is a deprecated alias) | registers the `email` config schema | none | not meant to be replaced |

## Related packages

- [`@spinajs/email-smtp-transport`](../email-smtp-transport/README.md): the SMTP `EmailSender`, template rendering and in-process retry.
- [`@spinajs/queue`](../queue/README.md): carries `EmailSend` jobs and the `EmailSent` and `EmailSendFailed` events.
- [`@spinajs/fs`](../fs/README.md): the filesystems attachments and templates are read from.
- [`@spinajs/configuration`](../configuration/README.md): `@AutoinjectService` builds the per-connection senders from `email.connections`.
- [`@spinajs/di`](../di/README.md): registration and lifetimes of `EmailService` and `EmailSender`.
- [`@spinajs/templates`](../templates/README.md): renders `IEmail.template` inside the SMTP transport.
- [`@spinajs/users`](../users/README.md): registers `EmailPasswordMailer` and sends lifecycle mails through `EmailService`.
- [`@spinajs/authz-fs`](../authz-fs/README.md): a filesystem whose `authz.fs.<name>.mode` is `enforce` or `audit` checks `fs:read` on attachments as the sending principal.
