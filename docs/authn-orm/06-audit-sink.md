# Login history

`@spinajs/authn-orm` stores no authentication events. A login history is a table trail of the audit trail: `@spinajs/audit-authn` records every authentication event as a `security` event, and a trail on `TableAuditStore` of `@spinajs/audit-orm` keeps them as rows.

## Where it runs in the authn flow

Every step of [How a login runs](../authn/01-authentication-flow.md) that publishes an event reaches the recorder, failures included: a throttled attempt (`throttle.block`), a refused or successful login, an identity linked in step 4 (`identity.link`), an MFA verification. The events and how each field lands in the trail are listed in [Audit events](../authn/06-audit-events.md#recording).

## Configuration

Install `@spinajs/audit-authn` and `@spinajs/audit-orm`, import both, and point `audit.authn.trail` at a table trail:

```ts
export default {
  audit: {
    trails: { logins: { store: 'TableAuditStore', table: 'audit_logins', retentionDays: 365 } },
    authn: { trail: 'logins' },
  },
};
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `audit.authn.trail` | `string` | `security` | The trail the recorder writes to. The built-in `security` trail writes to the log, not to a table. |
| `audit.trails.<name>.table` | `string` | none | The table of a `TableAuditStore` trail. |
| `audit.trails.<name>.retentionDays` | `integer` | none | Rows older than this are deleted by `AuditRetentionTask` of `@spinajs/audit-orm/scheduler`. |

The trail table is created by an `AuditTrailTableMigration` subclass of your own (see `@spinajs/audit-orm`).

## Reading it

```ts
import { audit } from '@spinajs/audit';

// Everything that happened to one account, as the subject of the event.
const history = await audit().trail('logins').of({ type: 'user', id: userUuid });

// Everything a principal did as the request's actor, such as the impersonations an admin ran.
const actions = await audit().trail('logins').byActor(`user:${adminUuid}`);
```

The identity is the subject only on a trail that leaves `data.identity` alone. A trail with an `omit`, `mask` or `hash` path that reaches it records no subject, and `of(...)` does not find those events.

## Important behaviour

- Rows of a table trail hold `data.identity`, `data.ip` and `data.userAgent` as they are, unless the trail hashes them. Treat the table as personal data.
- Events never carry passwords, tokens, secrets or raw session ids, so the trail holds none.
- A trail with `onFailure: 'reject'` makes the recorder blocking: a login whose event cannot be written fails with HTTP 503. See [Blocking listeners](../authn/06-audit-events.md#blocking-listeners).

## The `authn_audit` table of 3.x

3.x wrote one `authn_audit` row per event through `DbAuthnAuditSink`. 4.0 removes the sink, the `AuthnAudit` model, `AuthnAuditRetention` and `authn:audit-purge`. The initial migration no longer creates the table, and a database that already has it keeps it, unwritten and unpruned, with its rows. Drop it by hand once its history is no longer needed: see [Removed: the `authn_audit` table](../upgrading/4.0.md#removed-the-authn_audit-table-of-spinajsauthn-orm).

## Related

- [`@spinajs/authn` Audit events](../authn/06-audit-events.md): event types, delivery, and the recorder's mapping.
- [`@spinajs/audit-authn`](../../packages/audit-authn/README.md): the recorder and its trail.
