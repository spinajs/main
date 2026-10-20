# Audit sink

`DbAuthnAuditSink` writes one `authn_audit` row per authentication event: logins, logouts, MFA, sessions, passwords, tokens, keys, links, impersonation and throttle blocks. It is an `AuthnEventSink`, so it receives every event alongside the other sinks.

## Where it runs in the authn flow

Every step of [How a login runs](../authn/01-authentication-flow.md) that publishes an event reaches this sink, failures included: a throttled attempt (`throttle.block`), a refused or successful login, an identity linked in step 4 (`identity.link`), an MFA verification.

| Publisher | Events it writes here |
| --- | --- |
| `DefaultAuthnService` and `AuthnAudit` ([`@spinajs/authn`](../authn/06-audit-events.md)) | Logins, `completeMfa`, `reauthenticate`, links, sessions, impersonation. |
| `LocalPasswordService` ([`@spinajs/authn-local`](../authn-local/README.md)) | `password.change`, `password.reset.request`, `password.reset`, `invite.redeem`, `throttle.block`. |
| [`@spinajs/authn-token`](../authn-token/README.md) | `token.create`, `token.revoke`. |
| `KeyRegistry` ([`@spinajs/authn-keys`](../authn-keys/README.md)) | `key.register`, `key.revoke`. |
| `TotpService` ([`@spinajs/authn-totp`](../authn-totp/README.md)) | `mfa.enrol`, `mfa.disable`, `throttle.block`. |

The strategy packages resolve `Array.ofType(AuthnEventSink)` themselves or go through `AuthnAudit`; either way this sink is in the list once the package is imported.

## How it works

1. Importing `@spinajs/authn-orm` runs `@PerChildInstance()` and `@Injectable(AuthnEventSink)` on `DbAuthnAuditSink`. It is registered under `AuthnEventSink` and as itself.
2. The `AuthnAudit` service of `@spinajs/authn` (not the model of the same name in this package) resolves every registered `AuthnEventSink` and calls `publish(e)` on each, concurrently, each bounded by `authn.audit.sinkTimeoutMs`.
3. `DbAuthnAuditSink.publish(e)` turns `e.identity` and `e.actor` into `<type>:<id>` keys with `identityKey()`. A ref that does not fit the 100-character column leaves the column `NULL` and goes whole into `data` as `identityRef` or `actorRef`.
4. It cuts free text to its column, by code points: `type` 32, `outcome` 8, `strategy` 64, `reason` 64, `ip` 64, `user_agent` 255, `session` 64.
5. It serialises `e.data` plus the refs of step 3 to JSON. A `bigint` is written as a string; a value that does not serialise is written as `{"unserialisable":true}`. No data and no refs leaves `data` `NULL`.
6. It checks `e.at` (a valid `Date` between the years 1000 and 9999, else `InvalidArgument`), awaits `ormReady()` and inserts the row with a random UUID `id`.

A failing or slow sink is logged by `AuthnAudit` and never fails the login.

## Configuration

`DbAuthnAuditSink` reads no key. These `@spinajs/authn` keys apply to it:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.audit.sinkTimeoutMs` | `number` | `2000` | integer 1 to 60000 | How long `AuthnAudit` waits for one sink, this one included. |
| `authn.audit.hashIdentifiers` | `boolean` | `true` | `true`, `false` | Read by `LogAuthnAuditSink`. `DbAuthnAuditSink` never hashes. |

## Schema

### `authn_audit`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `varchar(36)`, primary key | Random UUID. |
| `at` | `datetime` | `AuthnEvent.at`. |
| `type` | `varchar(32)` | Event type, for example `login` or `mfa.enrol`. |
| `outcome` | `varchar(8)` | `success` or `failure`. |
| `identity` | `varchar(100)`, nullable | `<type>:<id>` of the identity the event is about. |
| `actor` | `varchar(100)`, nullable | `<type>:<id>` of `AuthnEvent.actor`, the principal who acted. |
| `strategy` | `varchar(64)`, nullable | Strategy name, for example `local`. |
| `reason` | `varchar(64)`, nullable | The real failure reason; the client never sees it. |
| `ip` | `varchar(64)`, nullable | Client IP from the trusted-proxy chain. |
| `user_agent` | `varchar(255)`, nullable | Client user agent. |
| `session` | `varchar(64)`, nullable | Hashed session handle, never the raw session id. |
| `data` | `text`, nullable | JSON of `AuthnEvent.data`, plus `identityRef` / `actorRef` when a ref did not fit its column. |

Index `authn_audit_at` covers `at`; index `authn_audit_identity` covers `(identity, at)`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Event sink | `AuthnEventSink`, resolved as a list; per child container; also registered as `DbAuthnAuditSink` | `DbAuthnAuditSink` | `LogAuthnAuditSink` (`@spinajs/authn`), `QueueAuthnEventSink` and `UserAccountSink` (`@spinajs/users`) | Add a sink with `@Injectable(AuthnEventSink)`. To replace this one, register your subclass and `DI.unregister(DbAuthnAuditSink)` before the list is first resolved. |

### Event sink: custom implementation

Every registered sink gets every event, so a subclass registered next to `DbAuthnAuditSink` writes each row twice. Unregister the base class when the subclass replaces it.

```ts sample
import { DbAuthnAuditSink } from '@spinajs/authn-orm';
import { AuthnEventSink } from '@spinajs/authn/contracts';
import type { AuthnEvent } from '@spinajs/authn/contracts';
import { DI, Injectable, PerChildInstance } from '@spinajs/di';

/** Keeps successful token and key uses out of authn_audit; every other event is stored. */
@PerChildInstance()
@Injectable(AuthnEventSink)
export class QuietAuditSink extends DbAuthnAuditSink {
  public override async publish(e: AuthnEvent): Promise<void> {
    if (e.outcome === 'success' && (e.type === 'token.use' || e.type === 'key.use')) return;
    await super.publish(e);
  }
}

DI.unregister(DbAuthnAuditSink);
```

## Important behaviour

- Event content never fails the write: long text is cut, an oversized ref moves to `data`, and unserialisable data becomes a marker. Only an invalid `e.at` throws.
- The sink does **not** hash: `identity`, `actor`, `ip` and `user_agent` are stored in clear. Treat the table as personal data.
- Events never carry passwords, tokens, secrets or raw session ids, so the table holds none.
- Every event is written, `token.use` and `key.use` successes included; there is no sampling.
- No sink may rely on delivery order: `AuthnAudit` publishes to every sink at once.
- Nothing in this package deletes `authn_audit` rows.

## Best practices

- Delete old rows from a maintenance job; the `authn_audit_at` index serves a delete by `at`.
- Query a user's history by `identity` and `at`, which the `authn_audit_identity` index covers.
- Keep `data` small: it is free-form JSON in a `text` column and is not indexed.

## Patterns and antipatterns

```ts
// Don't: both classes are AuthnEventSinks, so every event is written twice
@Injectable(AuthnEventSink)
export class QuietAuditSink extends DbAuthnAuditSink {}

// Do: unregister the base class the subclass replaces
@Injectable(AuthnEventSink)
export class QuietAuditSink extends DbAuthnAuditSink {}
DI.unregister(DbAuthnAuditSink);
```

## Examples

### Show a user's last 20 sign-ins

```ts sample
import { AuthnAudit, identityKey } from '@spinajs/authn-orm';
import { ormReady } from '@spinajs/orm';

export async function recentSignIns(userUuid: string): Promise<string[]> {
  await ormReady();
  const rows = await AuthnAudit.query()
    .where('identity', identityKey({ type: 'user', id: userUuid }))
    .where('type', 'login')
    .orderByDescending('at')
    .take(20);

  return rows.map((r) => `${r.at.toISO()} ${r.outcome} from ${r.ip ?? 'an unknown address'}`);
}
```

## Related

- [`@spinajs/authn` Audit and events](../authn/06-audit-events.md): event types, the fan-out, timeouts and the other sinks.
- [Models and schema](07-models-and-schema.md#authn_audit): the `AuthnAudit` model.
- [Multiple implementations](../di/06-multiple-implementations.md): how a list of `AuthnEventSink` is resolved.
