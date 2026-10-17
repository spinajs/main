# Secret redaction

`IEmail.redact` lists secret values that the mail's `model` or `text` carries: a reset token, a sign-in code, or the link holding them. Such a mail is never queued, and the values are replaced by `[redacted]` in the `EmailSent` event, logs, `Perf` spans and thrown errors. Use it for every mail that carries a credential.

## How it works

1. `sendDeferred()` refuses a mail whose `redact` holds a non-empty value: `InvalidOperation`. See [Deferred sending](04-deferred-sending.md).
2. `send()` hands the transport the full mail, `model` and `text` included.
3. A transport error is passed through `redactError(err, email.redact)` inside the `email.send` span, so the span, the error log and the rethrown error all carry the redacted copy.
4. `redactError()` returns the error unchanged when there is nothing to redact. Otherwise it returns a new `Error` with the same `name` and a redacted `message`, and no `cause`, stack of the original, or own fields (an SMTP response may quote the secret).
5. Redaction replaces each value raw and URI-encoded, longest first, so a link is replaced whole before the token inside it.
6. The `EmailSent` event leaves out `Model` and `Content` for such a mail.
7. The SMTP transport passes `redact` to `Templates.render()`, and redacts its own render and send errors the same way.

### Functions

| Export | Signature | Effect |
| --- | --- | --- |
| `REDACTED` | `'[redacted]'` | The replacement text. |
| `hasSecrets(email)` | `(Pick<IEmail, 'redact'>) => boolean` | `true` when `redact` holds a non-empty value. |
| `redactText(text, secrets)` | `(string, readonly string[] \| undefined) => string` | Replaces each secret, raw and URI-encoded. |
| `redactError(err, secrets)` | `<T>(T, readonly string[] \| undefined) => T \| Error` | `err` itself, or a new redacted `Error` without a cause. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Redaction helpers | plain functions | as above | | Call them from custom transports, mailers and `EmailService` overrides. |

`EmailPasswordMailer` and the `@spinajs/teams` invitation mailer both build on these: they put the token and the link into `redact` and wrap their own errors with `redactText()`.

## Important behaviour

- **Only `model`, `text` and errors are covered.** `subject`, `to`, `tag` and `emailId` are logged and sent in events as they are.
- **Empty strings are ignored.** `redact: ['']` does not count as a secret.
- **The redacted error has no cause.** Stack traces of the transport are lost on purpose.
- **Attachment read errors are not redacted.** They name a file path, and an `AccessDenied` keeps its class and decision.

## Best practices

- List both the token and every link that embeds it; the link may encode the token differently.
- Keep nodemailer's `logger` and `debug` options (in a connection's `options`) off where reset or invite mails are sent: they log whole message bodies.
- In a custom transport, redact before you log, not only before you throw.

## Patterns and antipatterns

```ts
// Don't: the original error, with the SMTP response quoting the body, reaches the logs
catch (err) { this.Log.error({ error: err }, 'send failed'); throw err; }

// Do
catch (err) { const failure = redactError(err, email.redact); this.Log.error({ error: failure }, 'send failed'); throw failure; }
```

## Examples

### Send a one-time sign-in code

```ts sample
import { DI } from '@spinajs/di';
import { EmailService } from '@spinajs/email';

export async function sendSignInCode(address: string, code: string, link: string): Promise<void> {
  const emails = await DI.resolve(EmailService);

  await emails.send({
    connection: 'main',
    to: [address],
    subject: 'Your sign-in code',
    text: `Your code is ${code}. Or open ${link}. It expires in 10 minutes.`,
    tag: 'sign-in-code',
    redact: [code, link],
  });
}
```

### Wrap your own mailer's errors

```ts sample
import { IOFail } from '@spinajs/exceptions';
import { emailSend, redactText } from '@spinajs/email';

export async function sendApiKey(address: string, apiKey: string): Promise<void> {
  const secrets = [apiKey];
  try {
    await emailSend({ connection: 'main', to: [address], subject: 'Your new API key', text: `Key: ${apiKey}`, redact: secrets });
  } catch (err) {
    // No cause: anything hanging off the original error may hold the key.
    throw new IOFail(`The API key mail was not sent: ${redactText(err instanceof Error ? err.message : String(err), secrets)}`);
  }
}
```

## Related

- [Deferred sending](04-deferred-sending.md): why secrets never go on the queue.
- [Password mails](08-password-mailer.md): the built-in user of `redact`.
- [`@spinajs/templates`](../templates/README.md): `IRenderOptions.redact` for render errors.
