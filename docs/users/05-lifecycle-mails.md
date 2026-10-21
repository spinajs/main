# Lifecycle mails

The [user actions](03-user-actions.md) notify the account owner by mail: created, activated, deactivated, banned, unbanned, deleted, password expired, password about to expire. Each mail is one `users.email.<name>` entry; turn it off, change its template or subject, or send it from your own code with `sendUserEmail()`.

Reset and invite mails are **not** sent here. They carry a secret, so authn-local sends them at once through its `PasswordMailer`, which users registers.

## How it works

1. An action calls `sendUserEmail(user, '<name>', model?)` as its last step.
2. `sendUserEmail()` reads `users.email.connection` (`'default'` when unset) and `users.email.<name>`. A missing entry throws `EmailTemplateNotConfigured`.
3. It checks the entry's `template` and `subject`: non-empty strings of at most 128 characters, or `InvalidArgument`.
4. With `enabled: true`, it calls `emailDeferred()` (`@spinajs/email`) with:
   - `to`: the user's `Email`;
   - `connection`, `template`, `subject` from config;
   - `model`: `user.toJSON()` merged with the action's extra model (for `passwordWillExpire`: `ExpiresAt`, an ISO string or `null`);
   - `tag`: `rbac-user-<name>`;
   - `attachements`: the entry's `attachments`, only when the list is non-empty.
5. `emailDeferred()` queues an `EmailSend` job; a worker sends it through the connection's transport, which renders the template from its `email.templateFs` filesystem.
6. `sendUserEmail()` resolves with the user, not the job.

### Which action sends which mail

| Entry | Sent by |
| --- | --- |
| `created` | `create()` with a password |
| `activated` | `activate()` |
| `deactivated` | `deactivate()` |
| `banned` | `ban()` |
| `unbanned` | `unban()` |
| `deleted` | `deleteUser()` |
| `passwordExpired` | `expirePassword()` |
| `passwordWillExpire` | `notifyPasswordWillExpire()` |
| `confirm` | no action; available to `sendUserEmail()` |

### Password mails (reset and invite)

`RbacBootstrapper` registers `EmailPasswordMailer` (`@spinajs/email`) as authn-local's `PasswordMailer`, unless something is already registered under `PasswordMailer` when the bootstrappers run. authn-local calls it for `PasswordService.invite()` (from `create()` without a password) and for password resets. See [Password mails](../email/08-password-mailer.md) for its configuration (`email.password.*`) and MJML templates.

It also registers a factory under authn-local's `AuthnMailDispatcher`, unless one is registered. When the `PasswordService` is built, the factory reads `authn.local.mail.delivery`: `'queue'` (the default) gives `QueueAuthnMailDispatcher`, `'inline'` the in-process one. Outside development and test, `'queue'` with `queue.routing.AuthnMailJob` routed to a missing connection or a `BlackHoleQueueClient` fails with `InvalidOption`. See [Mail delivery](../authn-local/13-mail-delivery.md).

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `users.email.connection` | `string` | `'rbac-email-connection'` | an `email.connections` name | Connection the lifecycle mails go through. The package defines no connection of that name. |
| `users.email.<name>.enabled` | `boolean` | `true` | | Send this mail. |
| `users.email.<name>.template` | `string` | see below | file name, at most 128 characters | Template file in the transport's `email.templateFs`. The `{ file, fs }` form is refused. |
| `users.email.<name>.subject` | `string` | see below | at most 128 characters | Subject. |
| `users.email.<name>.attachments` | `IEmailAttachement[]` | unset | | Inline images or files your template references (`cid:logo`). |

Shipped entries:

| `<name>` | `template` | `subject` |
| --- | --- | --- |
| `created` | `./user-creation-email-template.pug` | `Please confirm your email` |
| `banned` | `./user-banned-email-template.pug` | `Account banned` |
| `unbanned` | `./user-unbanned-email-template.pug` | `Account unbanned` |
| `deleted` | `./user-deleted-email-template.pug` | `Account deleted` |
| `deactivated` | `./user-deactivated-email-template.pug` | `Account deactivated` |
| `passwordExpired` | `./user-password-expired-template.pug` | `Password expired` |
| `passwordWillExpire` | `./user-password-will-expire-soon.pug` | `Your password will expire soon` |
| `activated` | `./user-activated-email-template.pug` | `Account activated` |
| `confirm` | `./user-confirmation-email-template.pug` | `Account created` |

```ts
// config/users.ts in your app
export default {
  email: {
    connections: [{ name: 'notifications', service: 'EmailSenderSmtp', host: 'smtp.acme.com', port: 587 }],
  },
  users: {
    email: {
      connection: 'notifications',
      banned: {
        enabled: true,
        template: 'acme/account-banned.pug',
        subject: 'Your Acme account is suspended',
        attachments: [{ name: 'logo.png', path: 'branding/logo.png', provider: 'mail-assets', cid: 'logo' }],
      },
      deleted: { enabled: false, template: './user-deleted-email-template.pug', subject: 'Account deleted' },
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Lifecycle mail content | `users.email.<name>` config | the shipped entries | | Override `template`, `subject`, `attachments`, or set `enabled: false`. |
| Lifecycle mail transport | `users.email.connection` → `@spinajs/email` connection | `rbac-email-connection` (not defined by users) | any connection | Define the connection in `email.connections`, or point the key at an existing one. |
| Password mailer | `PasswordMailer` (`@spinajs/authn-local`), singleton; registered by `RbacBootstrapper` only when none is registered | `EmailPasswordMailer` | your `PasswordMailer` | `DI.register(MyMailer).as(PasswordMailer)` before or after the bootstrap: before, the bootstrapper keeps yours; after, the last registration wins. |
| Authn mail dispatcher | `AuthnMailDispatcher` (`@spinajs/authn-local`), a factory registered by `RbacBootstrapper` only when none is registered | `QueueAuthnMailDispatcher` or `InlineAuthnMailDispatcher`, per `authn.local.mail.delivery` | your `AuthnMailDispatcher` | `DI.register(MyDispatcher).as(AuthnMailDispatcher)` before the bootstrap. |

### Password mailer: custom implementation

Send invites and resets through a transactional mail API instead of SMTP. The mailer must send at once and keep `secret` out of queues, logs and errors.

```ts sample
import { DI } from '@spinajs/di';
import { PasswordMailer } from '@spinajs/authn-local';
import type { PasswordMail } from '@spinajs/authn-local';

interface TransactionalMailApi {
  sendTemplate(templateId: string, to: string, variables: Record<string, string>): Promise<void>;
}

export class ApiPasswordMailer extends PasswordMailer {
  constructor(private readonly api: TransactionalMailApi) {
    super();
  }

  public async send(mail: PasswordMail): Promise<void> {
    if (!mail.to.email) {
      throw new Error(`No address for ${mail.identity.type}:${mail.identity.id}`);
    }

    const link = mail.url ? `${mail.url}?token=${encodeURIComponent(mail.secret)}&email=${encodeURIComponent(mail.to.email)}` : '';

    try {
      await this.api.sendTemplate(mail.purpose === 'invite' ? 'acme-invite' : 'acme-reset', mail.to.email, {
        name: mail.to.name ?? mail.to.email,
        link,
        minutes: String(Math.round(mail.ttlSeconds / 60)),
      });
    } catch {
      // The API error may echo the request, secret included.
      throw new Error(`The ${mail.purpose} mail was not sent`);
    }
  }
}

// A factory, because the mailer needs the API client. A factory is not cached: keep the client cheap to share.
export function useApiMailer(api: TransactionalMailApi): void {
  DI.register(() => new ApiPasswordMailer(api)).as(PasswordMailer);
}
```

### Send a lifecycle mail from your own action

`sendUserEmail()` takes one of the shipped entry names. Point an entry at your own template and pass extra model fields as a function of the user.

```ts sample
import { getUser, sendUserEmail } from '@spinajs/users';

// users.email.confirm is sent by no shipped action: reuse it for a re-confirmation mail.
export async function askToConfirmEmailAgain(uuid: string, confirmUrl: string): Promise<void> {
  const user = await getUser(uuid);
  await sendUserEmail(user, 'confirm', (u) => ({ ConfirmUrl: `${confirmUrl}?user=${u.Uuid}` }));
}
```

## Important behaviour

- The lifecycle mails are **queued** (`EmailSend` job). Never put a secret in the `model`: it would be stored in the queue.
- The shipped `connection` is `rbac-email-connection`, which no package defines. Without a connection of that name, or an override, the actions still succeed, but every queued `EmailSend` job fails in the worker and no lifecycle mail is delivered.
- The default `.pug` templates are published in `lib/templates/` (`node_modules/@spinajs/users/lib/templates`). Nothing points a filesystem at them: copy them, or your own templates with these names, into your `email.templateFs` filesystem, or point that filesystem at the folder.
- `template` and `subject` are validated even when `enabled` is `false`. A disabled entry still needs both strings.
- A mail failure in an action surfaces **after** the state change is stored; for `create()` it becomes `UserCreatedIncomplete`.
- The template model is `user.toJSON()`; metadata keys that `dehydrateWithRelations()` hides are not in it.

## Best practices

- Point `users.email.connection` at your app's notification connection instead of defining `rbac-email-connection`.
- Use `attachments` for branded inline images; nothing in the stack attaches them for you.
- Override `email.password.*` for invite and reset mails, not `users.email.*`; they come from different code.

## Patterns and antipatterns

```ts
// Don't: a reset link in a queued lifecycle mail is stored in the queue in clear text
await sendUserEmail(user, 'confirm', () => ({ ResetUrl: resetLinkWithToken }));

// Do: reset and invite links go through PasswordService, which sends them at once
await passwordService.invite({ type: 'user', id: user.Uuid }, { now: new Date(), purpose: 'request' });
```

## Related

- [User actions](03-user-actions.md): the actions that send these mails.
- [Deferred sending](../email/04-deferred-sending.md): what `emailDeferred()` queues.
- [Password mails](../email/08-password-mailer.md): `EmailPasswordMailer` and `email.password.*`.
- [Attachments](../email/05-attachments.md): the `IEmailAttachement` shape.
