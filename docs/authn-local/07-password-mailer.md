# Password mailer

`PasswordMailer` sends the reset and invite messages that carry a single-use secret. `LocalPasswordService.deliver()` calls it right after it issues the secret, when a dispatched mail request is delivered ([Mail delivery](13-mail-delivery.md)). The package ships only the abstract class; `@spinajs/users` registers `EmailPasswordMailer` from `@spinajs/email` unless the app registered its own.

## How it works

1. A flow needs a mail: `requestReset()` (deferred), `invite()`, or `expire()` with `cause: 'aged'` or `sendReset: true`.
2. `LocalPasswordService.mailer()` answers the optional `@Autoinject(PasswordMailer)` property, set when a mailer was registered when the service was built. None: a warning is logged, **nothing is dispatched and no secret is issued**, and the event records the failure reason `no_mailer`.
3. The flow dispatches an `AuthnMailRequest`, which holds no secret. When it is delivered, `deliver()` drops a request older than its lifetime.
4. `IdentityStore.display(id)` gives the recipient's `email` and `name`. No `email`: nothing is issued or sent.
5. `SecretStore.issue(id, purpose, ttlSeconds)` returns the raw secret. Without a `SecretStore` this step throws `InvalidOperation`.
6. `PasswordMailer.send(mail)` runs at once with a `PasswordMail`.

| Field | Type | Meaning |
| --- | --- | --- |
| `identity` | `IdentityRef` | Whose secret it is. |
| `purpose` | `'reset' \| 'invite'` | Which message. |
| `to` | `{ email?: string; name?: string }` | From `IdentityStore.display()`. |
| `secret` | `string` | The raw single-use secret. |
| `url` | `string` | `authn.local.reset.url`, the page that redeems the secret, for both purposes. May be `''`. |
| `ttlSeconds` | `number` | `authn.local.reset.ttlSeconds` or `authn.local.invite.ttlSeconds`. |
| `lang` | `string`, optional | The language of the request, when it named one. |

What happens to an error from `send()` depends on the delivery, never on the flow, which has already answered:

| Delivery | A `send()` error |
| --- | --- |
| inline | Logged by error name. |
| queue | Fails the `AuthnMailJob`; the queue retries it, and each retry issues a fresh secret. |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.local.reset.url` | `string` | `''` | a URL | Passed as `mail.url`. |
| `authn.local.reset.ttlSeconds` | `integer` | `3600` | `>= 1` | Passed as `mail.ttlSeconds` for a reset. |
| `authn.local.invite.ttlSeconds` | `integer` | `900` | `>= 1` | Passed as `mail.ttlSeconds` for an invite. |

The default mailer's own keys (`email.password.*`) are on [Password mails](../email/08-password-mailer.md).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Mailer | `PasswordMailer`, optional `@Autoinject` of `LocalPasswordService`, set when the service is built | `EmailPasswordMailer`, registered by `@spinajs/users`' `RbacBootstrapper` only when none is registered | your `PasswordMailer` | `DI.register(MyMailer).as(PasswordMailer)`. Registered before the users bootstrapper, it is kept; after, the last registration wins. Without `@spinajs/users`, register one yourself. |

The contract for every implementation (SR-09):

- Render and send at once. Never put `secret`, or a link that holds it, into a queue, a database row, an event or a log line.
- An error must not carry the secret in its message.
- Throw when the message cannot be sent; the calling flow decides what to do with it.

### Mailer: custom implementation

Text reset codes to field staff who have no email address.

```ts sample
import { DI } from '@spinajs/di';
import type { IdentityRef } from '@spinajs/authn';
import { PasswordMailer } from '@spinajs/authn-local';
import type { PasswordMail } from '@spinajs/authn-local';

interface SmsGateway {
  send(phone: string, text: string): Promise<void>;
}

interface StaffDirectory {
  phoneOf(identity: IdentityRef): Promise<string | null>;
}

export class SmsPasswordMailer extends PasswordMailer {
  constructor(private readonly sms: SmsGateway, private readonly staff: StaffDirectory) {
    super();
  }

  public async send(mail: PasswordMail): Promise<void> {
    const phone = await this.staff.phoneOf(mail.identity);
    if (!phone) {
      throw new Error(`No phone number for ${mail.identity.type}:${mail.identity.id}`);
    }

    const minutes = Math.round(mail.ttlSeconds / 60);
    const what = mail.purpose === 'invite' ? 'Set up your account' : 'Reset your password';
    try {
      await this.sms.send(phone, `${what} with code ${mail.secret}. It works once, for ${minutes} minutes.`);
    } catch {
      // A gateway error may echo the message text, code included.
      throw new Error(`The ${mail.purpose} text was not sent`);
    }
  }
}

// A factory, because the mailer needs its clients; it runs on every resolve, so keep them cheap to share.
export function useSmsMailer(sms: SmsGateway, staff: StaffDirectory): void {
  DI.register(() => new SmsPasswordMailer(sms, staff)).as(PasswordMailer);
}
```

## Important behaviour

- **No mailer, no secret.** Without a registered `PasswordMailer`, reset and invite issue nothing and send nothing; the flows still answer as usual.
- **The secret is issued right before `send()`** and exists nowhere else: `LocalPasswordService` never returns it, and neither its events nor a queued `AuthnMailJob` hold it.
- **`url` is the reset URL for invites too.** Build the invite link from it, or ignore it and use your own page per `purpose`.
- **The mailer is optional.** An app without one boots; only the mails are skipped, each with a logged warning. Register it before `PasswordService` is first resolved: the service takes it when it is built.

## Best practices

- Keep `send()` synchronous with the provider call. Queue the request (`authn.local.mail.delivery: 'queue'`), never the mail: a queued mail would have to store the secret.
- Use `mail.purpose` to pick the template; one mailer serves both.
- Test your mailer with a fake transport and assert the secret never shows up in logged output.

## Patterns and antipatterns

```ts
// Don't: the queue persists the job, secret included, and retries may send stale codes. AuthnMailJob queues the request instead.
public async send(mail: PasswordMail): Promise<void> {
  await queue.emit(new SendResetMailJob(mail.to.email, mail.secret));
}

// Do: send in the call, and keep the secret out of any error.
public async send(mail: PasswordMail): Promise<void> {
  await transport.send(render(mail));
}
```

## Related

- [Reset and invite](06-reset-and-invite.md): the flows that call the mailer.
- [Password expiry](08-password-expiry.md): the reset mail after an expiry.
- [`@spinajs/email`](../email/08-password-mailer.md): `EmailPasswordMailer`, its config and templates.
- [`@spinajs/users`](../users/05-lifecycle-mails.md): who registers the default mailer, and when.
