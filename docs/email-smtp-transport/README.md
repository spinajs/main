# `@spinajs/email-smtp-transport`

The SMTP transport for `@spinajs/email`. `EmailSenderSmtp` sends each mail through a `nodemailer` SMTP transporter: it renders the template, attaches the files, and guards the send with a timeout and retries.

It does **not** queue, redirect or count mail, and it emits no events. `EmailService` from `@spinajs/email` does that and calls this transport. It also has no provider-side templates: `IEmail.templateId` is ignored.

## Install

```sh
npm install @spinajs/email-smtp-transport
```

## Features

| Feature | What it does |
| --- | --- |
| [SMTP connection](01-smtp-connection.md) | Connection config, how a connection selects `EmailSenderSmtp`, the connect-and-verify step at boot, raw `nodemailer` options |
| [Sending mail](02-sending-mail.md) | `send()`: sender address, template rendering, attachments, the `IEmail` to `nodemailer` mapping, redaction and errors |
| [Send resilience](03-send-resilience.md) | The timeout and retry pipeline around `sendMail`, its config, and the `buildSendPipeline()` hook |
| [Extending the SMTP sender](04-extending-the-smtp-sender.md) | DI registration, subclassing `EmailSenderSmtp` (transporter, `send()`, pipeline), `nodemailer` plugins, and selecting the subclass per connection |

## Quick start

Configure one SMTP connection, import the package once so `EmailSenderSmtp` registers itself, and send through `EmailService`.

```ts sample
import '@spinajs/email-smtp-transport';
import { DI } from '@spinajs/di';
import { EmailService } from '@spinajs/email';

// config/email.ts
export const config = {
  email: {
    defaultConnection: 'smtp-main',
    connections: [
      {
        service: 'EmailSenderSmtp',
        name: 'smtp-main',
        host: 'smtp.example.com',
        port: 587,
        user: process.env.SMTP_USER,
        password: process.env.SMTP_PASSWORD,
        defaults: { mailFrom: 'no-reply@example.com' },
      },
    ],
  },
};

export async function sendWelcome(address: string) {
  const emails = await DI.resolve(EmailService);

  await emails.send({
    connection: 'smtp-main',
    to: [address],
    subject: 'Welcome to Example',
    text: 'Your account is ready.',
  });
}
```

## Related packages

- [`@spinajs/email`](../email/README.md): `EmailService`, `IEmail`, `EmailSender` and the `email.*` configuration this transport plugs into.
- [`@spinajs/templates`](../templates/README.md): the `Templates` service that renders `IEmail.template`.
- [`@spinajs/fs`](../fs/README.md): the filesystems templates and attachments are read from.
- [`@spinajs/util`](../util/README.md): `ResiliencePipelineBuilder`, the timeout and retry strategies used around the send.
- [`@spinajs/di`](../di/README.md): the container `EmailSenderSmtp` is registered in.
