# Replacing or extending `EmailService`

`EmailService` is the DI token every mail goes through: your code, `emailSend()`, the deferred `EmailSend` job, the CLI commands and `EmailPasswordMailer` all resolve it. Subclass `DefaultEmailService` to change one step of sending; replace the token to change all of it, e.g. with a recording double in tests.

## How it works

1. `DefaultEmailService` is decorated `@Injectable(EmailService)`, so importing `@spinajs/email` registers it under the `EmailService` token. Lifetime is singleton (the DI default).
2. `DI.resolve(EmailService)` resolves the **last** class registered under the token. A class registered after the package import wins.
3. Building the instance injects the members of the abstract `EmailService`: `Senders` (one [`EmailSender`](02-transports.md) per connection), `Configuration`, `Queue` and `Log`.
4. `resolve()` then runs. `DefaultEmailService.resolve()` logs an error for each connection with `redirectTo` when the app runs as production.
5. Every caller holds the same instance until the container cache is cleared.

### Who resolves `EmailService`

| Caller | How |
| --- | --- |
| Your code | `@Autoinject(EmailService)`, `DI.resolve(EmailService)` |
| `emailSend()`, `emailDeferred()`, `_emailSend()`, `_emailDeferred()` | `resolve(EmailService)` on each call |
| `EmailSend.execute()` (deferred worker) | `emailSend(this)` |
| `email-send`, `email-server` CLI commands | `@LazyInject()` |
| `EmailPasswordMailer` | `DI.resolve(EmailService)`, unless built with `Deps` |
| `@spinajs/users` lifecycle mails | `emailDeferred()` |
| `@spinajs/teams` invitation mailer | `DI.resolve(EmailService)` |

A replacement therefore also changes how deferred jobs are delivered.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Email service | `EmailService`, singleton, resolved by type (last registration wins) | `DefaultEmailService` | none shipped | Subclass `DefaultEmailService` and decorate it `@Injectable(EmailService)`, or `DI.register(MyService).as(EmailService)`. Register before the first resolve. |

### Members of the abstract `EmailService`

| Member | Kind | Source |
| --- | --- | --- |
| `Log` | protected `Log` | `@Logger('email')` |
| `Senders` | protected `Map<string, EmailSender>` | `@AutoinjectService('email.connections', EmailSender)` |
| `Configuration` | protected `EmailConfiguration` | `@Config('email')` |
| `Queue` | protected `QueueService` | `@Autoinject(QueueService)` |
| `send(email)` | abstract | Send now. |
| `sendDeferred(email)` | abstract | Queue the mail; return the `EmailSend` job. |
| `processDeferredEmails()` | abstract | Consume `EmailSend` jobs. |

### Overridable steps of `DefaultEmailService`

| Member | Default behaviour | Override to |
| --- | --- | --- |
| `send(email)` | The [send pipeline](01-sending-email.md#how-it-works). | Change the mail before or after the pipeline; call `super.send()`. |
| `readAttachments(email)` | Copy of the mail with each attachment's local `file` set, or with `file` dropped when `email.attachments.check` is off. | Add virus scanning, size limits, or a different read policy. |
| `sendDeferred(email)` | Refuse `redact`, build and emit `EmailSend`. | Add defaults to every queued mail. |
| `processDeferredEmails()` | `Queue.consume(EmailSend)`. | Consume from more job types. |
| `resolve()` | Production warning for `redirectTo`. | Validate your own config; call `super.resolve()`. |
| `IsProduction` | Getter: `configuration.isProduction` when it is a boolean, else `APP_ENV ?? NODE_ENV` normalized to `prod`. | Decide production from another source. |
| `CheckAttachments` | `@Config('email.attachments.check', { defaultValue: true })`. | Read by `readAttachments()`. |
| `DefaultFileProvider` | `@Config('fs.defaultProvider')`. | Filesystem of attachments without `provider`. |

### Extend: archive copy of every billing mail

A subclass that adds a BCC to mails tagged `billing`. It copies the mail instead of mutating it, because a retried job passes the same object again.

```ts sample
import { Injectable } from '@spinajs/di';
import { DefaultEmailService, EmailService, IEmail } from '@spinajs/email';

@Injectable(EmailService)
export class ArchivingEmailService extends DefaultEmailService {
  public async send(email: IEmail): Promise<void> {
    const archived = email.tag === 'billing' ? { ...email, bcc: [...(email.bcc ?? []), 'archive@acme.com'] } : email;
    await super.send(archived);
  }
}
```

Import this module once at startup, after `@spinajs/email` (its own import guarantees that). It is registered last, so `DI.resolve(EmailService)` returns it everywhere.

### Extend: refuse oversized attachments

`readAttachments()` runs before the transport, as the caller. Override it to check the files the service has read.

```ts sample
import { stat } from 'node:fs/promises';
import { Injectable } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { DefaultEmailService, EmailService, IEmail } from '@spinajs/email';

const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

@Injectable(EmailService)
export class SizeLimitedEmailService extends DefaultEmailService {
  protected async readAttachments(email: IEmail): Promise<IEmail> {
    const read = await super.readAttachments(email);

    let total = 0;
    for (const a of read.attachements ?? []) {
      if (a.file) {
        total += (await stat(a.file)).size;
      }
    }

    if (total > MAX_TOTAL_BYTES) {
      throw new InvalidArgument(`Attachments of "${email.subject}" take ${total} bytes, the limit is ${MAX_TOTAL_BYTES}`);
    }

    return read;
  }
}
```

An error thrown here is logged, counted as `email.send.failed`, and rethrown unchanged, like a refused read.

### Replace: record mails in integration tests

A full replacement implements the three abstract methods. Register it and drop the cached instance before the code under test resolves the service.

```ts sample
import { DI } from '@spinajs/di';
import { EmailSend, EmailService, IEmail } from '@spinajs/email';

export class RecordingEmailService extends EmailService {
  public readonly Sent: IEmail[] = [];
  public readonly Deferred: IEmail[] = [];

  public async send(email: IEmail): Promise<void> {
    this.Sent.push(email);
  }

  public async sendDeferred(email: IEmail): Promise<EmailSend> {
    this.Deferred.push(email);
    const job = new EmailSend();
    job.hydrate(email);
    return job;
  }

  public async processDeferredEmails(): Promise<void> {
    // nothing is queued
  }
}

export async function recordEmails(): Promise<RecordingEmailService> {
  DI.register(RecordingEmailService).as(EmailService);
  DI.uncache(EmailService);
  return (await DI.resolve(EmailService)) as RecordingEmailService;
}
```

## Important behaviour

- **A subclass of the abstract `EmailService` still builds every configured transport**, because `Senders` is injected by the base class. In tests, configure `email.connections` with `BlackHoleEmailSender` entries or none.
- **Registration order decides.** A class registered under `EmailService` before `@spinajs/email` is imported loses to `DefaultEmailService`.
- **The service is cached.** A registration made after the first resolve is used only after `DI.uncache(EmailService)` or a cleared container.
- **`@Config` and `@Logger` members are getter-only accessors** on the prototype. Assigning them on an instance throws; in a unit test shadow them with `Object.defineProperty`.

## Best practices

- Override one step and call `super`: you keep redirect, redaction, metrics and the `EmailSent` event.
- Return a new mail object from overrides; never edit the argument.
- Prefer a [custom transport](02-transports.md) when only the delivery changes. Replace the service when the pipeline itself changes.

## Patterns and antipatterns

```ts
// Don't: mutating the job's own mail stacks the change on every queue retry
public async send(email: IEmail) { email.bcc = [...(email.bcc ?? []), 'archive@acme.com']; await super.send(email); }

// Do
public async send(email: IEmail) { await super.send({ ...email, bcc: [...(email.bcc ?? []), 'archive@acme.com'] }); }
```

## Related

- [Sending email](01-sending-email.md): the default pipeline.
- [Transports](02-transports.md): replacing only the delivery.
- [Deferred sending](04-deferred-sending.md): the job that calls the service.
- [`@spinajs/di`](../di/README.md): registration order and lifetimes.
