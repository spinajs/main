# `@spinajs/hooks`

Action hooks for SpinaJS: code that runs before, after or on failure of a named action, resolved through the DI container. A before hook can change the inputs the action declares mutable, or refuse the action. An after hook observes the input and the result. A failed hook observes a thrown error.

It does **not** intercept methods. Hooks run only where an action calls `Hooks.run`. It is not an audit stream, and a hook never widens an action: it cannot grant access, skip an invariant, or change an input the action did not declare mutable. The package knows no auth, users or ORM package; each package declares its own actions.

## Install

```sh
npm install @spinajs/hooks
```

## Features

| Feature | What it does |
| --- | --- |
| [Writing a hook](01-writing-a-hook.md) | The `ActionHook` contract, action patterns, order, mutable keys, refusal, errors and timeouts, `bag`, depth, logging, the testing kit. |
| [Declaring actions](02-declaring-actions.md) | For package authors: add actions to `HookActions`, call `Hooks.run`, map `ActionRefused` and `ActionHookFailed`, keep security invariants. |

## Quick start

```ts sample
import { Injectable } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';
import type { BeforeContext } from '@spinajs/hooks';

declare module '@spinajs/hooks' {
  interface HookActions {
    'orders.place': { input: { customerId: string; total: number }; output: { id: string } };
  }
}

@Injectable(ActionHook)
export class OrderLimitHook extends ActionHook<'orders.place'> {
  public readonly actions = ['orders.place'] as const;

  public before(ctx: BeforeContext<'orders.place'>): void {
    if (ctx.input.total > 10_000) {
      ctx.refuse('order.over_limit');
    }
  }
}
```

## Related packages

- [`@spinajs/di`](../di/README.md): resolves hooks and the `Hooks` service.
- [`@spinajs/configuration`](../configuration/README.md): supplies `hooks.timeoutMs` and `hooks.maxDepth`.
- [`@spinajs/exceptions`](../exceptions/README.md): base class of `ActionRefused` and `ActionHookFailed`.
- [`@spinajs/log-common`](../log-common/README.md): the `hooks` log that receives hook failures.
