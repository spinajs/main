# Signals are checked as their signer

A workflow can ask for a permission on a signal: `ctx.waitForEvent('approved', { permission: 'orders:approve' })`.
`@spinajs/authz-workflow` checks the principal the signal was stamped with when the wait consumes it, which can be
long after the signal was sent. `@spinajs/users/workflow` registers `UserSignalPrincipalFactory`, which reads that
user again at that moment: the signal of a user deactivated, banned or deleted since signing is rejected, and an
active user is checked with the attributes it has now.

## Install

`@spinajs/authz-workflow` is an optional peer dependency. Install it and import the subpath once in the application
entry, before the `Configuration` resolves:

```sh
npm install @spinajs/authz-workflow
```

```ts
import '@spinajs/users/workflow';
```

The subpath imports authz-workflow, which loads `@spinajs/workflow` and registers its signal authorizer. Importing
`@spinajs/users` alone loads none of it. Without this import, authz-workflow's own `StampedSignalPrincipalFactory`
trusts the stamp and logs one warning.

## How it works

1. A signal is stored with the principal that signed it, as `type:id`. `@spinajs/workflow-http` stamps the caller;
   code that calls `WorkflowService.signal()` names the principal itself.
2. When a wait with a `permission` finds the signal, `AuthzSignalAuthorizer` calls
   `SignalPrincipalFactory.principalOf({ type, id })` and checks the permission as the principal it gets.
3. `UserSignalPrincipalFactory.principalOf()`:
   - a value that is not `{ type, id }` with non-empty strings gives `UNATTENDED` and logs a warning;
   - an `agent` stamp gives `UNATTENDED`;
   - a stamp of another type than `user` goes to authz-workflow's `StampedSignalPrincipalFactory`;
   - a `user` stamp whose `id` is not a UUID gives `UNATTENDED`;
   - it reads the user through `userModel()` as `SYSTEM`, `Metadata` populated; unknown, soft-deleted, inactive or
     banned gives `UNATTENDED`;
   - otherwise it returns the principal [`UserPrincipalFactory`](09-principal-factory.md) builds for that record,
     with source `'workflow'` (`WORKFLOW_PRINCIPAL_SOURCE`) and the attribute providers' attributes.
4. A failing user store or attribute provider throws. The workflow engine then keeps the signal pending and asks
   again on the next activation, rather than rejecting a signal it could not judge.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Signal principal factory | `SignalPrincipalFactory` (`@spinajs/authz-workflow`), singleton, `@Injectable` when `@spinajs/users/workflow` is imported | `UserSignalPrincipalFactory` | authz-workflow's `StampedSignalPrincipalFactory` (trusts the stamp, no reload) | Extend `UserSignalPrincipalFactory` and register the subclass with `DI.register(X).as(SignalPrincipalFactory)`. |
| User principal building | `PrincipalFactory`, when it is a `UserPrincipalFactory`; else users' `UserPrincipalFactory` | `UserPrincipalFactory` | your subclass | See [Principal factory](09-principal-factory.md). |

### Custom signal factory: refuse users under a compliance hold

```ts sample
import { DI } from '@spinajs/di';
import { UNATTENDED } from '@spinajs/authz';
import type { Principal, PrincipalRef } from '@spinajs/authz';
import { SignalPrincipalFactory } from '@spinajs/authz-workflow';
import { User } from '@spinajs/users';
import { UserSignalPrincipalFactory } from '@spinajs/users/workflow';

export class HoldAwareSignalFactory extends UserSignalPrincipalFactory {
  public async principalOf(ref: PrincipalRef): Promise<Principal> {
    const principal = await super.principalOf(ref);

    if (principal.type === 'user' && principal.identity instanceof User && principal.identity.Metadata['compliance:hold'] === true) {
      return UNATTENDED;
    }

    return principal;
  }
}

DI.register(HoldAwareSignalFactory).as(SignalPrincipalFactory);
```

## Important behaviour

- The user is read when the wait **consumes** the signal, not when the signal was sent.
- `UNATTENDED` is nobody: unless a model grants it something, the signal is marked `rejected` and the wait goes on
  waiting for the next one.
- An agent stamp is never checked as the agent.
- A signal without a permission on its wait is not checked at all; this factory is not asked.
- This factory and the one for queue jobs ([Jobs run as their initiator](16-jobs-run-as-initiator.md)) are separate
  services, registered by separate imports.
