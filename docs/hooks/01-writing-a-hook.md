# Writing a hook

An `ActionHook` runs code around a named action: before it (change inputs or refuse), after it (observe the result) and when it throws (observe the error). Use one to apply an application rule to an action a package already exposes, such as a signup rule or a notification.

## How it works

1. You register a class that extends `ActionHook` and lists the actions it wants in `actions`.
2. At boot, `DefaultHooks.resolve()` reads the registered hook types and their `actions` patterns. Hook instances are not built yet.
3. An action calls `Hooks.run(action, input, impl, opts)`. The runner looks up the hooks that match the action, cached per action name. With none, it returns `impl(input)` and builds no context.
4. The first matching run resolves the hook instances. The runner copies the input into `ctx.input` and calls each `before` hook in ascending `order`, each bounded by `hooks.timeoutMs`.
5. The runner calls `impl` with `{ ...original, ...pick(ctx.input, opts.mutable) }`. Assignments to other keys are dropped.
6. When `impl` returns, the `after` hooks run in descending `order`. The output is returned unchanged.
7. When `impl` throws, the `failed` hooks run in descending `order`, one at a time, and the original error is rethrown.

A hook implements any of `before`, `after` and `failed`; a phase it does not implement is skipped.

## Hook contract

| Member | Type | Meaning |
| --- | --- | --- |
| `actions` | `readonly ActionPattern[]` | Required. The actions the hook handles. |
| `order` | `number`, default `0` | Position among matching hooks. |
| `before(ctx)` | `BeforeContext<A>` | Change `ctx.input`, call `ctx.refuse(code)`, or return. |
| `after(ctx)` | `AfterContext<A>` | Read `ctx.input` and `ctx.output`. |
| `failed(ctx)` | `FailedContext<A>` | Read `ctx.input` and `ctx.error`. |

Every context carries `action`, `bag` and `depth`. `input` is writable only in `before`; in `after` and `failed` it is `Readonly`.

## Action patterns

`actions` takes three forms:

| Pattern | Matches |
| --- | --- |
| `'authn.login'` | That action only. |
| `'authn.*'` | Every action under the prefix: `authn.login` and `authn.password.change`, not `authnx.login`. A longer prefix such as `'authn.password.*'` narrows it. |
| `'*'` | Every action. |

`Hooks.has(action)` is `false` when no registered hook matches.

## Order

- `before` hooks run in ascending `order`: the lowest number runs first.
- `after` and `failed` hooks run in descending `order`: the lowest number runs last, so hooks unwind in the reverse of how they wrapped the action.
- Hooks with equal `order` keep registration order.

## Mutable keys

An action declares which input keys a `before` hook can change (`mutable` in `RunOptions`). The action receives the original input with only those keys taken from `ctx.input`. An assignment to any other key is dropped, and logged as a warning once per hook class. The action's own documentation lists its mutable keys.

The action also checks again the invariants that guard the changed values, so a hook can narrow an action but never widen it. See [Declaring actions](02-declaring-actions.md#security-invariants).

## Refusing an action

`ctx.refuse(code, message?)` throws `ActionRefused` and stops the run: `impl` and later hooks do not run.

- `code` must match `/^[a-z0-9][a-z0-9_.-]{0,58}$/`, so the audit reason `hook:<code>` fits the 64-character reason columns.
- A code outside that format is an error in the hook: the run throws `ActionHookFailed` with reason `'error'`.
- What the caller sees is the action's decision. Each action maps `ActionRefused` to its own answer; see the action's documentation.
- An action that cannot be refused (`refusable: false`) logs the refusal and runs anyway.

## Errors and timeouts

| What happens in a `before` hook | Result |
| --- | --- |
| `ctx.refuse(code)` | `ActionRefused`; the run stops. |
| Any other throw | `ActionHookFailed` with reason `'error'`, carrying the hook class name; the run stops. |
| The hook takes longer than `hooks.timeoutMs` | `ActionHookFailed` with reason `'timeout'`; the run stops. |

- With `refusable: false`, a refusal, a throw and a timeout in `before` are logged and the run goes on.
- An `after` hook that throws or times out is logged and swallowed; the output is returned unchanged.
- A `failed` hook that throws is logged. It never masks the error of `impl`, which is rethrown.
- A `failed` hook runs only when `impl` throws. A result such as `status: 'failure'` is a result, so it reaches `after`.

<!-- TODO(docs-hook): verify whether hooks.timeoutMs also bounds a failed hook, and whether a timed-out hook is cancelled or only abandoned -->

## Shared state: `bag`

`ctx.bag` is one `Map<string, unknown>` shared by the `before`, `after` and `failed` calls of a single run. Set a value in `before`, read it in `after` or `failed`. It does not outlive the run and is not shared between runs.

## Depth

`ctx.depth` is `1` for a top-level run. A hook that runs another action (a `before` hook calling a users action) triggers that action's hooks with `depth + 1`. Past `hooks.maxDepth`, the run throws `ActionHookFailed` with reason `'depth'`.

## When hooks are collected

- Hook **types** are collected at boot. A hook registered after boot is not used.
- Hook **instances** are resolved on the first run of an action they match, not at boot. A hook can inject a service that injects `Hooks` without a dependency cycle.

Import the module that registers your hook before the application boots.

## Logging

Hook failures are logged on the `hooks` log with the hook class name, the action and the error class. The error message and the input are never logged, since an input can hold a password. Keep input values out of your own `refuse` messages for the same reason.

<!-- TODO(docs-hook): verify whether the refuse message reaches the caller or the log -->

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `hooks.timeoutMs` | number | `5000` | 1 to 60000 | Time bound for one hook call, in milliseconds. |
| `hooks.maxDepth` | number | `8` | 1 to 32 | Maximum nesting of action runs started from hooks. |

```ts
export default {
  hooks: {
    timeoutMs: 2000,
    maxDepth: 4,
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Hooks | `Hooks` (abstract), singleton in the root container | `DefaultHooks` | none | Inject `Hooks`. |
| Action hooks | `ActionHook` (abstract), the type list is read at boot | none | any number | `@Injectable(ActionHook)` on your class, imported before boot. |

<!-- TODO(docs-hook): verify the registration form for a hook class (@Injectable(ActionHook) vs DI.register(...).as(ActionHook)) and how to replace Hooks -->

## Important behaviour

- With no matching hook, an action pays a lookup: `impl` gets the same input object and no context is built.
- A `before` hook sees a shallow copy of the input. Assign to top-level keys; nested objects are shared with the caller.
- A hook on `authn.login` runs before the throttle and before the password check, so a refusal there is fast. It must not branch on whether an account exists; use `authn.login.identified` for account-dependent rules. The input of `authn.login` carries no identity.
- Hooks do not replace guards. Where an action has its own guard, both the guard and the hooks must allow.

## Best practices

- Give each hook one concern and a class name that says it; the class name is what the log shows.
- Keep `before` hooks short. Each one is bounded by `hooks.timeoutMs` and delays the action.
- Keep side effects in `after` hooks. An `after` failure cannot undo the action, so make the hook safe to lose.
- Use the narrowest pattern. A `'*'` hook is considered for every action.
- Pick refusal codes as stable lowercase identifiers (`order.over_limit`); they become audit reasons.

## Patterns and antipatterns

```ts
// Don't: the input can hold a password
ctx.refuse('password_rejected', `bad password ${ctx.input.password}`);

// Do: a code only
ctx.refuse('password_rejected');
```

## Testing kit

`@spinajs/hooks/testing` holds three helpers, so tests need no hand-written hook.

| Export | Effect |
| --- | --- |
| `RecordingActionHook` | Records every call in `calls`: `phase` (`'before'`, `'after'` or `'failed'`), `action`, `input`, and `output` or `error`. |
| `refusingHook(pattern, code, opts?)` | A hook that refuses matching actions with `code`. `opts.order` sets `order`. |
| `mutatingHook(pattern, patch, opts?)` | A hook that assigns `patch` to `ctx.input` in `before`. Only the mutable keys of the action reach it. |

```ts
import { RecordingActionHook, refusingHook, mutatingHook } from '@spinajs/hooks/testing';

const recorder = new RecordingActionHook();
const refuse = refusingHook('orders.*', 'order.blocked', { order: -10 });
const stamp = mutatingHook('orders.place', { note: 'checked' });

// After a run: recorder.calls[0].phase === 'before'
```

<!-- TODO(docs-hook): verify how a test registers these hook instances in the container, and which actions RecordingActionHook matches -->

## Examples

### Block large orders and time the rest

```ts sample
import { Injectable } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';
import type { AfterContext, BeforeContext } from '@spinajs/hooks';

declare module '@spinajs/hooks' {
  interface HookActions {
    'orders.place': {
      input: { customerId: string; total: number; note?: string };
      output: { id: string };
    };
  }
}

@Injectable(ActionHook)
export class OrderRulesHook extends ActionHook<'orders.place'> {
  public readonly actions = ['orders.place'] as const;

  public readonly order = 10;

  public before(ctx: BeforeContext<'orders.place'>): void {
    if (ctx.input.total > 10_000) {
      ctx.refuse('order.over_limit');
    }

    ctx.bag.set('startedAt', Date.now());
    ctx.input.note = `${ctx.input.note ?? ''} [checked]`.trim();
  }

  public after(ctx: AfterContext<'orders.place'>): void {
    const startedAt = ctx.bag.get('startedAt') as number;
    console.log(`order ${ctx.output.id} placed in ${Date.now() - startedAt} ms`);
  }
}
```

`note` reaches `orders.place` only when that action lists it in `mutable`; see [Declaring actions](02-declaring-actions.md).

## Related

- [Declaring actions](02-declaring-actions.md): how an action exposes itself to hooks.
- [Multiple implementations](../di/06-multiple-implementations.md): how lists of services are registered.
