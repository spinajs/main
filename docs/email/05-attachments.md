# Attachments

Attachments name a file on a `@spinajs/fs` filesystem: local disk, S3 or any other provider. `EmailService.send()` reads each one through its filesystem as the caller, before the transport runs, so a filesystem whose `authz.fs.<name>.mode` is `enforce` or `audit` checks `fs:read` (through `AuthzFsMiddleware`, see [Checks on file actions](../authz-fs/02-checks-on-file-actions.md)) for the principal that sends the mail.

## How it works

`DefaultEmailService.readAttachments(email)` runs as step 2 of [`send()`](01-sending-email.md#how-it-works):

1. A mail without attachments is passed on as it is.
2. With `email.attachments.check` off, it returns a copy whose attachments have `file` removed. The transport reads `path` itself, as whoever runs the transport.
3. With the check on (default), it calls `downloadAttachment(a, fs.defaultProvider)` for each attachment, in order, and returns a copy with `file` set to the local path.
4. `downloadAttachment()` resolves the filesystem named by `a.provider`, else `fs.defaultProvider`, and calls its `download(a.path)`. An unknown filesystem throws `IOFail` (`Filesystem provider for <name> not registered...`).
5. Any read error, `AccessDenied` included, is logged once, counted as `email.send.failed`, and rethrown unchanged. Nothing is sent.
6. The transport calls `attachmentFile(a, defaultProvider)`, which returns `a.file` when set and downloads `a.path` otherwise.

The caller's mail is never changed, and a `file` the caller set is always dropped or overwritten: a caller or a queued payload cannot hand the transport an unread local path.

### `IEmailAttachement`

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | `string` | File name shown in the mail. Unicode is allowed. |
| `path` | `string` | Path on the filesystem. |
| `provider` | `string` | Filesystem name. Default: `fs.defaultProvider`. |
| `cid` | `string` | Content id, to embed an image in an HTML body (`<img src="cid:logo">`). |
| `file` | `string` | Local file the service read. Set only by the service. |

### Helper functions

| Function | Returns | Use |
| --- | --- | --- |
| `downloadAttachment(a, defaultProvider)` | `Promise<string>` local path | Always downloads `a.path` through `a.provider ?? defaultProvider`. Throws `IOFail` for an unknown filesystem. |
| `attachmentFile(a, defaultProvider)` | `Promise<string>` local path | `a.file` when set, else `downloadAttachment()`. Use it in transports. |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `email.attachments.check` | `boolean` | `true` | `true`, `false` | `true`: the service reads attachments as the caller. `false`: the transport reads them, as whoever runs it. |
| `fs.defaultProvider` | `string` | not set | registered fs provider | Filesystem of attachments without `provider`. |

```ts
// config/email.ts in your app
export default {
  email: { attachments: { check: true } },
  fs: { defaultProvider: 'fs-local' },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Attachment read | `DefaultEmailService.readAttachments()` (protected) | download each, set `file` | check off: drop `file` | Override in a subclass, see [03](03-email-service.md#extend-refuse-oversized-attachments). |
| Filesystems | `@spinajs/fs` providers, by name | `fs.defaultProvider` | any provider, e.g. `@spinajs/fs-s3` | Register a provider and name it in `provider`. |
| Transport read | `attachmentFile()` in each `EmailSender` | `file`, else download | | Call it from your own transport, see [02](02-transports.md#transport-contract). |

## Important behaviour

- **This holds for every transport**, `BlackHoleEmailSender` included: development and tests fail where production would.
- **Deferred mails read attachments on delivery**, as the principal that queued them (`EmailSend` runs as initiator). A mail queued without one is refused on a checked filesystem.
- **A refused deferred read is retried** like any failed job, although the answer stays the same.
- **Templates are not covered.** The transport reads templates in the same context; give template filesystems no `authz.fs` entry, because reset and invite mails run without a user.
- **Downloaded copies are not deleted by this package.** For a remote provider, `download()` writes to the temp filesystem and its cleanup applies.

## Best practices

- Set `provider` on every attachment that is not on `fs.defaultProvider`; the default is a config key and can change per environment.
- Keep `email.attachments.check` on. Turning it off makes the worker's identity, not the sender's, decide access.
- Use `cid` with an HTML template for logos instead of linking remote images.

## Patterns and antipatterns

```ts
// Don't: the service drops a caller's `file`; the transport never sees this path
attachements: [{ name: 'invoice.pdf', path: 'invoice.pdf', file: '/tmp/invoice-104.pdf' }]

// Do: name the file on its filesystem
attachements: [{ name: 'invoice.pdf', path: 'invoices/2026/INV-104.pdf', provider: 'invoices-s3' }]
```

## Examples

### Send an invoice PDF stored on S3

```ts sample
import { Autoinject, Injectable } from '@spinajs/di';
import { EmailService } from '@spinajs/email';

@Injectable()
export class InvoiceMailer {
  @Autoinject(EmailService)
  protected Emails: EmailService;

  public async sendInvoice(customer: string, invoiceNo: string): Promise<void> {
    await this.Emails.send({
      connection: 'main',
      to: [customer],
      subject: `Invoice ${invoiceNo}`,
      template: 'invoice.pug',
      model: { InvoiceNo: invoiceNo },
      tag: 'billing',
      attachements: [
        { name: `${invoiceNo}.pdf`, path: `invoices/${invoiceNo}.pdf`, provider: 'invoices-s3' },
        { name: 'logo.png', path: 'brand/logo.png', provider: 'assets', cid: 'logo' },
      ],
    });
  }
}
```

## Related

- [Transports](02-transports.md): how a transport consumes `file`.
- [Deferred sending](04-deferred-sending.md): `runAs: 'initiator'`.
- [`@spinajs/fs`](../fs/README.md): providers, `download()` and the temp filesystem.
- [`@spinajs/authz-fs`](../authz-fs/README.md): does the `fs:read` checks.
