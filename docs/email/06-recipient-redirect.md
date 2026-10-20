# Recipient redirect

`redirectTo` on a connection replaces every recipient of every mail with test inboxes and records the real recipients in the subject. Use it on dev and staging stacks that must exercise the real SMTP path without mailing real people. Production refuses it.

## How it works

1. `DefaultEmailService.send()` reads `redirectTo` of the mail's connection, unless `IsProduction` is true; then it uses no redirect.
2. `redirectRecipients(email, redirectTo)` returns `null` when `redirectTo` is missing or empty. The mail is sent as it is.
3. Otherwise it returns a copy with:
   - `to` set to the `redirectTo` addresses;
   - `cc` and `bcc` removed;
   - the subject prefixed with the original `to` addresses: `[DEV->a@x.com,b@x.com] `, `[DEV->a,b,c +2 more] ` past three, `[DEV] ` when `to` was empty.
4. The service logs a warning with the counts and a trace line with the original addresses.
5. Only the transport gets the copy. Logs and the `EmailSent` event keep the original mail.

`IsProduction` is `configuration.isProduction` when it is a boolean. Without one it is `normalizeEnvironment(APP_ENV ?? NODE_ENV ?? 'development') === 'prod'`.

At startup `DefaultEmailService.resolve()` logs an error for each connection that sets `redirectTo` on production: `Email connection <name> configures redirectTo, which is refused on production. Recipients are NOT redirected.`

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `email.connections[].redirectTo` | `string[]` | not set | addresses | Test inboxes that receive every mail of the connection. Ignored on production. |
| `configuration.isProduction` | `boolean` | from `@spinajs/configuration` | | `true` turns every redirect off. |

```ts
// email section of the staging stack's configuration
export default {
  email: {
    connections: [
      {
        name: 'main',
        service: 'EmailSenderSmtp',
        host: 'smtp.acme.com',
        port: 587,
        redirectTo: ['qa-inbox@acme.com'],
      },
    ],
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Production check | `DefaultEmailService.IsProduction` (protected getter) | `configuration.isProduction`, then env | | Override the getter in a subclass, see [03](03-email-service.md). |
| Redirect | `redirectRecipients()` function | as above | | Call it from your own `send()` override or transport. |

## Important behaviour

- **Production never redirects**, whatever the connection says. The check runs on every send, so it does not depend on injection order.
- **The redirect is per connection.** A staging config can redirect `main` and leave an internal `ops` connection alone.
- **`cc` and `bcc` are dropped**, so a redirected mail reaches only the test inboxes.
- **`redirectRecipients()` never mutates its argument.** A retried job would otherwise get a second prefix.
- **The subject prefix holds real addresses.** It reaches only the transport and the test inbox, never the info or error logs.

## Best practices

- Set `redirectTo` only in the configuration of dev and staging stacks, never in the config shared with production. The production guard is a safety net, not the switch.
- Point `redirectTo` at a shared QA inbox, not a developer's personal address.

## Examples

### Preview how a staging connection rewrites a mail

```ts sample
import { IEmail, redirectRecipients } from '@spinajs/email';

const invoice: IEmail = {
  connection: 'main',
  to: ['anna@client.com', 'bob@client.com', 'carol@client.com', 'dan@client.com'],
  cc: ['accounts@client.com'],
  subject: 'Invoice INV-104',
};

const redirected = redirectRecipients(invoice, ['qa-inbox@acme.com']);

// redirected.to      -> ['qa-inbox@acme.com']
// redirected.cc      -> undefined
// redirected.subject -> '[DEV->anna@client.com,bob@client.com,carol@client.com +1 more] Invoice INV-104'
export const preview = redirected;
```

## Related

- [Sending email](01-sending-email.md): where the redirect runs.
- [`@spinajs/configuration`](../configuration/README.md): `configuration.isProduction` and environment names.
