# Initiator principal factory

`InitiatorPrincipalFactory` turns the `Initiator` stamped on a message back into the principal a `runAs: 'initiator'` job runs as. Replace it when a job must see the user as they are when it runs (deactivated, banned, new attributes), not as they were when it was queued.

## How it works

1. `AuthzQueueHook.aroundHandle()` calls `InitiatorPrincipalFactory.principalOf(message.Initiator)` for a job whose `@Job()` says `runAs: 'initiator'` and whose message has an `Initiator` ([Job authorization](01-job-authorization.md#how-it-works)). No other path calls it.
2. The `Initiator` comes straight from the broker's JSON: any field may be missing or of the wrong type, and `ceiling.expiresAt` is a string.
3. The default, `StampedInitiatorPrincipalFactory.principalOf()`:
   1. On its first call, it warns once on `console.warn` that jobs run from the stamp alone, unless `authz.queue.stampedInitiatorWarning` is `false` or it was built with `{ warn: false }`.
   2. It returns `UNATTENDED` when the stamp is not an object, or when `type` or `id` is not a non-empty string.
   3. It returns `SYSTEM` for `type: 'system'` and `UNATTENDED` for `type: 'unattended'`.
   4. It rebuilds a present, non-null `ceiling` with `reviveCeiling()`. A ceiling that cannot be rebuilt gives `UNATTENDED`.
   5. It returns a frozen principal: `{ type, id, authenticated: type !== 'anonymous', source: 'queue', attributes: {}, ceiling? }`.
4. The hook runs the job inside `runAs()` with the returned principal. A factory that throws fails the job, so the transport can retry it.

`reviveCeiling(raw)` rebuilds a `Ceiling` after JSON:

- It copies `roles` and `permissions` (string arrays), `resources` (`{ type, id? }` with string fields), `expiresAt` (a `Date`, an ISO string or a number of milliseconds, turned into a `Date`) and `reason` (a string).
- A field that is `null` counts as absent. Unknown fields are dropped.
- It returns `undefined` when the value is not an object or any known field has the wrong shape.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.queue.stampedInitiatorWarning` | `boolean` | `true` | `true`, `false` | `false` silences the one-time warning of `StampedInitiatorPrincipalFactory`, for an app that accepts jobs running from the stamp alone. A non-boolean fails boot; a non-boolean set at runtime keeps the warning. It is read at the factory's first call. |

```ts
export default {
  authz: {
    queue: { stampedInitiatorWarning: false },
  },
};
```

A `StampedInitiatorPrincipalFactory` built with `new StampedInitiatorPrincipalFactory({ warn: false })` never warns and never reads the config. Use it inside a factory that does reload users and delegates other types to the stamped one.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Initiator principal factory | `InitiatorPrincipalFactory` (abstract class), singleton; the default registers itself with `@Injectable(InitiatorPrincipalFactory)` at import | `StampedInitiatorPrincipalFactory`: trusts the stamp, reloads nothing | `UserInitiatorPrincipalFactory` from `@spinajs/users/queue`: reloads the user, gives `UNATTENDED` for a deleted, inactive or banned one ([Jobs run as their initiator](../users/16-jobs-run-as-initiator.md)) | Extend `InitiatorPrincipalFactory`, implement `principalOf(initiator)`, then `DI.register(MyFactory).as(InitiatorPrincipalFactory)` before the queue handles its first job. |

`AuthzQueueHook` takes the factory with `@Autoinject` when DI builds the hook, so a factory registered after that is never used.

### Initiator principal factory: custom implementation

Implement `principalOf(initiator)`:

- Return `UNATTENDED` for an initiator that can no longer act (unknown, disabled, deleted).
- Throw only for a failure worth a retry, such as an unreachable user store.
- Validate the stamp's fields: they come from the broker untyped.
- Rebuild a stamped ceiling with `reviveCeiling()` and keep it. Dropping it gives the job more rights than its emitter had.

This factory reloads service accounts from the app's own store and leaves every other type to the stamped factory.

```ts sample
import '@spinajs/authz-queue';
import { DI } from '@spinajs/di';
import { UNATTENDED } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { InitiatorPrincipalFactory, StampedInitiatorPrincipalFactory, reviveCeiling } from '@spinajs/authz-queue';
import type { Initiator } from '@spinajs/authz-queue';

export interface ServiceAccount {
  id: string;
  enabled: boolean;
  team: string;
}

// Stand-in for the app's store of API clients.
export const serviceAccounts = new Map<string, ServiceAccount>();

export class ServiceAccountInitiatorFactory extends InitiatorPrincipalFactory {
  // Users are still rebuilt from the stamp alone, so this keeps the one-time warning.
  private readonly stamped = new StampedInitiatorPrincipalFactory();

  public async principalOf(initiator: Initiator): Promise<Principal> {
    if (initiator.type !== 'service') return this.stamped.principalOf(initiator);
    if (typeof initiator.id !== 'string') return UNATTENDED;

    const account = serviceAccounts.get(initiator.id);
    if (!account || !account.enabled) return UNATTENDED;

    const ceiling = initiator.ceiling === undefined ? undefined : reviveCeiling(initiator.ceiling);
    if (initiator.ceiling !== undefined && ceiling === undefined) return UNATTENDED;

    return Object.freeze({
      type: 'service',
      id: account.id,
      authenticated: true,
      source: 'queue',
      attributes: Object.freeze({ team: account.team }),
      ...(ceiling ? { ceiling } : {}),
    });
  }
}

DI.register(ServiceAccountInitiatorFactory).as(InitiatorPrincipalFactory);
```

## Important behaviour

- **The default does not know about deactivation.** It builds the principal without reading any user record, so a user deactivated or banned after emitting still acts in their queued jobs. The models still evaluate that principal's roles and grants when the job checks.
- **The principal is rebuilt when the job runs**, so a reloading factory sees the user's state at run time, not at emit time.
- **The warning is once per factory instance**, at its first call, not at boot.
- **`source` is `'queue'`** on every principal the default builds; rules can tell queued work apart with it.
- **`authn` facts and `onBehalfOf` are never rebuilt**: the stamp does not carry them, and such principals are not stamped at all.

## Best practices

- Import `@spinajs/users/queue` in apps that use `@spinajs/users`, instead of writing your own user reload.
- Keep `stampedInitiatorWarning: true` until a reloading factory is registered; set it to `false` only when the stamp-only behaviour is a decision.
- Return `UNATTENDED` rather than throwing for an initiator that is gone: a throw makes the transport retry a job that can never succeed.
- To add a rule on top of the user reload (a compliance hold, a locked tenant), extend `UserInitiatorPrincipalFactory` from `@spinajs/users/queue` rather than `InitiatorPrincipalFactory`; [Jobs run as their initiator](../users/16-jobs-run-as-initiator.md) has a sample.

## Related

- [Job authorization](01-job-authorization.md): when the hook calls the factory, and what the stamp contains.
- [Jobs run as their initiator](../users/16-jobs-run-as-initiator.md): the factory `@spinajs/users/queue` registers.
- [Authorization concepts](../authz/01-check-flow.md#concepts): principals, ceilings and `UNATTENDED`.
