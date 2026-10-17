# Transports (`EmailSender`)

An `EmailSender` delivers one mail over one connection: SMTP, an HTTP mail API, a file outbox, or nothing at all. Each `email.connections` entry names its transport class in `service`; the email service builds one instance per entry. Write your own sender to use a mail provider this repository does not ship.

## How it works

1. **Registration.** A transport class is decorated `@Injectable(EmailSender)` and `@NewInstance()`. `@Injectable(EmailSender)` adds it to the `EmailSender` registrations; `@NewInstance()` gives every connection its own instance.
2. **Selection.** `EmailService` declares `@AutoinjectService('email.connections', EmailSender) protected Senders: Map<string, EmailSender>`. When the service is built, the container reads `email.connections` and, for each entry, finds the registered `EmailSender` class whose class **name** equals the entry's `service`.
3. **Construction.** The container calls the constructor with the whole connection entry as the only argument. The class stores it in `Options`.
4. **Resolve.** The container awaits the sender's `resolve()`. `EmailSender.resolve()` looks up the filesystem named by `email.templateFs` into `defaultTemplateFs`, and throws `ResolveException` when that filesystem is not registered.
5. **Mapping.** The instances go into a `Map` keyed by `ServiceName`, which returns `Options.name`.
6. **Use.** `DefaultEmailService.send()` picks `Senders.get(email.connection)` and calls `send(copy)`. See [Sending email](01-sending-email.md#how-it-works).

An entry whose `service` matches no registered `EmailSender` makes the resolve of `EmailService` fail with `ServiceNotFound` (`Service <name> is not registered in DI container`).

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `email.connections[].name` | `string` | required | unique | Map key and `ServiceName` of the sender. |
| `email.connections[].service` | `string` | required | class name of an `@Injectable(EmailSender)` class | Which transport class handles the connection. |
| `email.connections[].options` | `object` | not set | transport-specific | Free-form options for your transport. |
| `email.templateFs` | `string` | `'email-templates'` | registered fs provider | Resolved into `defaultTemplateFs` by every sender. |
| `fs.defaultProvider` | `string` | not set | registered fs provider | Exposed to senders as `DefaultFileProvider`. |

```ts
// config/email.ts in your app
export default {
  email: {
    connections: [
      { name: 'transactional', service: 'HttpApiEmailSender', options: { endpoint: 'https://mail.example.net/v1/send', apiKey: process.env.MAIL_API_KEY } },
      { name: 'dev-outbox', service: 'OutboxEmailSender', options: { fs: 'mail-outbox' } },
      { name: 'silent', service: 'BlackHoleEmailSender' },
    ],
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Transport | `EmailSender`, `@NewInstance()`, one per `email.connections` entry, resolved by class name when `EmailService` is built | none; a connection must name one | `BlackHoleEmailSender` (here), `EmailSenderSmtp` ([`@spinajs/email-smtp-transport`](../email-smtp-transport/README.md)) | Subclass `EmailSender`, decorate `@Injectable(EmailSender) @NewInstance()`, put the class name in `service`. Subclass `EmailSenderSmtp` to tweak SMTP. |

### What `EmailSender` gives a subclass

| Member | Kind | Meaning |
| --- | --- | --- |
| `Options` | `EmailConnectionOptions` | The connection entry. Set it from the constructor argument. |
| `ServiceName` | getter | `Options.name`; the map key. Keep it. |
| `send(email)` | abstract | Deliver the mail. Throw to fail it. |
| `resolve()` | async | Resolves `defaultTemplateFs`. Call `super.resolve()` when you override it. |
| `defaultTemplateFs` | `fs` | Filesystem from `email.templateFs`, for string `template` values. |
| `defaultTemplateFsName` | `string` | `email.templateFs`. |
| `DefaultFileProvider` | `string` | `fs.defaultProvider`; pass it to `attachmentFile()`. |

### Shipped senders

| Class | `service` value | Behaviour |
| --- | --- | --- |
| `BlackHoleEmailSender` | `'BlackHoleEmailSender'` | Reads each attachment that has no `file` through its filesystem, logs `Email <subject> sent to black hole`, sends nothing. A refused read still fails the send. |
| `BlackHoleEmailTransport` | none | Empty `send()`. Registered with `@Injectable()` only, so it is **not** an `EmailSender` registration and cannot be named in `service`. Use `BlackHoleEmailSender`. |

### Transport contract

A transport receives a copy of the caller's mail. It should:

- Send `attachements[].file` when present: the service already read it as the caller. Use `attachmentFile(a, this.DefaultFileProvider)`, which returns `file` or downloads `path`.
- Pass any error through `redactError(err, email.redact)` before logging or throwing it.
- Throw on failure. The service counts it, logs it and rethrows it, and the queue retries a deferred mail.
- Fall back to `Options.defaults?.mailFrom` when `email.from` is missing, as the SMTP transport does.

### Custom transport: HTTP mail API

Use this when a provider offers an HTTP API instead of SMTP. It validates its options at resolve time, so a bad entry fails at boot.

```ts sample
import { readFile } from 'node:fs/promises';
import { Injectable, NewInstance, ResolveException } from '@spinajs/di';
import { IOFail } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { attachmentFile, EmailConnectionOptions, EmailSender, IEmail, redactError } from '@spinajs/email';

interface HttpApiOptions {
  endpoint: string;
  apiKey: string;
}

@Injectable(EmailSender)
@NewInstance()
export class HttpApiEmailSender extends EmailSender {
  @Logger('email')
  protected Log: Log;

  constructor(public Options: EmailConnectionOptions) {
    super();
  }

  protected get Api(): HttpApiOptions {
    return this.Options.options as HttpApiOptions;
  }

  public async resolve(): Promise<void> {
    await super.resolve();

    if (!this.Api?.endpoint || !this.Api?.apiKey) {
      throw new ResolveException(`Email connection ${this.Options.name} needs options.endpoint and options.apiKey`);
    }
  }

  public async send(email: IEmail): Promise<void> {
    const attachments = await Promise.all(
      (email.attachements ?? []).map(async (a) => ({
        filename: a.name,
        contentId: a.cid,
        content: (await readFile(await attachmentFile(a, this.DefaultFileProvider))).toString('base64'),
      })),
    );

    const response = await fetch(this.Api.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.Api.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: email.from ?? this.Options.defaults?.mailFrom,
        to: email.to,
        cc: email.cc,
        bcc: email.bcc,
        replyTo: email.replyTo,
        subject: email.subject,
        text: email.text,
        templateId: email.templateId,
        variables: email.model,
        tags: email.tag ? [email.tag] : [],
        attachments,
      }),
    });

    if (!response.ok) {
      // The provider may echo the message body back, secrets included.
      throw redactError(new IOFail(`Mail API answered ${response.status}: ${await response.text()}`), email.redact);
    }

    this.Log.trace({ connection: this.Options.name, status: response.status }, 'Mail API accepted mail on ${connection}: ${status}');
  }
}
```

Register it by importing the module before `EmailService` is first resolved, then name it in config:

```ts
// config/email.ts
export default {
  email: {
    connections: [{ name: 'transactional', service: 'HttpApiEmailSender', options: { endpoint: 'https://mail.example.net/v1/send', apiKey: process.env.MAIL_API_KEY } }],
  },
};
```

### Custom transport: local outbox for development

Writes every mail as JSON to a filesystem, so developers read mails without an SMTP server.

```ts sample
import { Injectable, NewInstance, ResolveException } from '@spinajs/di';
import { fs, getFs } from '@spinajs/fs';
import { EmailConnectionOptions, EmailSender, IEmail } from '@spinajs/email';

@Injectable(EmailSender)
@NewInstance()
export class OutboxEmailSender extends EmailSender {
  protected Outbox: fs;

  constructor(public Options: EmailConnectionOptions) {
    super();
  }

  public async resolve(): Promise<void> {
    await super.resolve();

    const name = (this.Options.options as { fs?: string } | undefined)?.fs;
    const outbox = getFs(name);
    if (!outbox) {
      throw new ResolveException(`Email connection ${this.Options.name}: options.fs must name a registered filesystem`);
    }
    this.Outbox = outbox;
  }

  public async send(email: IEmail): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await this.Outbox.write(`${stamp}-${email.emailId ?? 'mail'}.json`, JSON.stringify(email, null, 2));
  }
}
```

### Extending the SMTP transport

`EmailSenderSmtp` keeps its pieces in protected members: `Transporter`, `SendPipeline`, `buildSendPipeline()`. Subclass it, register the subclass under `EmailSender` and name the subclass in `service`. See [Extending the SMTP sender](../email-smtp-transport/04-extending-the-smtp-sender.md).

## Important behaviour

- **`service` is a class name.** A bundler or minifier that renames classes breaks the lookup. Keep class names in production builds.
- **Every connection is built and resolved when `EmailService` is.** One broken entry fails the whole service, not only its own mails.
- **`email.templateFs` is checked for every sender**, the black hole included. The shipped value `'email-templates'` must name a registered filesystem, or set the key to your template filesystem.
- **Each entry gets its own instance.** State on a sender (a connection pool, a counter) is per connection; share it through a static or another singleton.
- **The sender sees the redirected copy** with the local `file` of every attachment set (with `email.attachments.check` on).

## Best practices

- Validate `Options` in `resolve()` and throw `ResolveException`: a typo then fails at boot, not on the first mail.
- Call `attachmentFile()` instead of reading `path` yourself, so an attachment the service already read is not read again as another principal.
- Keep provider secrets (`password`, an API key) in environment variables referenced from the config file.

## Patterns and antipatterns

```ts
// Don't: registered as itself only; `service: 'MyTransport'` then fails with ServiceNotFound
@Injectable()
export class MyTransport extends EmailSender { /* ... */ }

// Do
@Injectable(EmailSender)
@NewInstance()
export class MyTransport extends EmailSender { /* ... */ }
```

```ts
// Don't: skips the template filesystem lookup every sender relies on
public async resolve() { this.Client = createClient(this.Options); }

// Do
public async resolve() { await super.resolve(); this.Client = createClient(this.Options); }
```

## Related

- [Sending email](01-sending-email.md): the pipeline around `send()`.
- [Attachments](05-attachments.md): `attachmentFile()` and `downloadAttachment()`.
- [Secret redaction](07-secret-redaction.md): `redactError()` for transport errors.
- [`@spinajs/configuration`](../configuration/README.md): `@AutoinjectService`.
- [`@spinajs/email-smtp-transport`](../email-smtp-transport/README.md): the SMTP sender.
