# Writing a hook

An `ActionHook` runs code around a named action: before it (change inputs or refuse), after it (observe the result) and when it throws (observe the error). Use one to apply an application rule to an action a package already exposes, such as a signup rule or a notification.

## How it works

1. You register a class that extends `ActionHook` and lists the actions it wants in `actions`.
2. At boot, `DefaultHooks.resolve()` reads the registered hook types and their `actions` patterns. A hook registered as a factory (`() => instance`) is called at boot, so its instance exists from then on. A class registration gets a probe instance built with `new` and a DI instance on the first matching run.
3. An action calls `Hooks.run(action, input, impl, opts)`. The runner looks up the hooks that match the action, cached per action name. With none, it returns `impl(input)` and builds no context.
4. The runner copies the input into `ctx.input` and calls each `before` hook in ascending `order`, each bounded by `hooks.timeoutMs`. A hook with a `before` is resolved from DI right before its call, and that resolution is bounded by `hooks.timeoutMs` too. After each `before` hook the runner puts the keys that are not mutable back to their original values and removes the non-mutable keys the hook added, so the next hook sees what the action will see.
5. The runner calls `impl` with `{ ...original, ...pick(ctx.input, opts.mutable) }`. Assignments to other keys are dropped.
6. When `impl` returns, the `after` hooks run in descending `order`. A hook not resolved yet (no `before`) is resolved here. The output is returned unchanged.
7. When `impl` throws, the `failed` hooks run in descending `order`, one at a time, resolved the same way, and the original error is rethrown.

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

An action declares which input keys a `before` hook can change (`mutable` in `RunOptions`). The action receives the original input with only those keys taken from `ctx.input`. An assignment to any other key is dropped, and logged as a warning once per hook class. Deleting a mutable key keeps its original value. The action's own documentation lists its mutable keys.

The action also checks again the invariants that guard the changed values, so a hook can narrow an action but never widen it. See [Declaring actions](02-declaring-actions.md#security-invariants).

## Refusing an action

`ctx.refuse(code, message?)` throws `ActionRefused` and stops the run: `impl` and later hooks do not run.

- `code` must match `/^[a-z0-9][a-z0-9_.-]{0,58}$/`, so the audit reason `hook:<code>` fits the 64-character reason columns.
- A code outside that format is an error in the hook: the run throws `ActionHookFailed` with reason `'error'`.
- What the caller sees is the action's decision. Each action maps `ActionRefused` to its own answer; see the action's documentation.
- An action that cannot be refused (`refusable: false`) logs the refusal and runs anyway. The depth limit (`hooks.maxDepth`) is always enforced, even with `refusable: false`.

## Errors and timeouts

| What happens in a `before` hook | Result |
| --- | --- |
| `ctx.refuse(code)` | `ActionRefused`; the run stops. |
| Any other throw | `ActionHookFailed` with reason `'error'`, carrying the hook class name; the run stops. |
| The hook takes longer than `hooks.timeoutMs` | `ActionHookFailed` with reason `'timeout'`; the run stops. |
| The hook sets `ctx.input` to something other than an object | `ActionHookFailed` with reason `'error'`; `ctx.input` goes back to its value before that hook. |
| The hook fails to resolve from DI | `ActionHookFailed` with reason `'error'`; the run stops. |
| The hook takes longer than `hooks.timeoutMs` to resolve from DI | `ActionHookFailed` with reason `'timeout'`; the run stops. |

- With `refusable: false`, a refusal, a throw, a timeout and a failed resolution in `before` are logged and the run goes on. A hook that failed to resolve is skipped for the rest of the run, `after` and `failed` included. The depth limit (`hooks.maxDepth`) is still enforced.
- A hook with only `after` or `failed` that fails to resolve, or times out resolving, is logged and skipped. It never fails the action.
- A failed resolution is not cached: the next run tries to resolve the hook again. A resolution that times out stays pending: until it settles, later runs treat the hook as a failed resolution at once (reason `'timeout'`, no waiting), and once it resolves the hook is used.
- A resolution that times out is abandoned but stays cached until it settles. Later runs wait on the same pending resolution, so a hook that never resolves keeps timing out.
- An `after` hook that throws or times out is logged and swallowed; the output is returned unchanged.
- A `failed` hook that throws is logged. It never masks the error of `impl`, which is rethrown.
- A `failed` hook runs only when `impl` throws. A result such as `status: 'failure'` is a result, so it reaches `after`.
- `hooks.timeoutMs` bounds every hook call: `before`, `after` and `failed`. A timed-out `after` or `failed` hook is logged.
- A timed-out hook is abandoned, not cancelled: its promise keeps running. Do not start work in a hook that must not outlive the timeout.

## Constructor rules

The runner reads `actions`, `order` and which of `before`, `after` and `failed` the hook defines at boot, from a probe instance built with `new`, outside DI. A constructor that throws on the probe fails the boot with `Hook <name> could not be constructed to read its actions`. A hook whose `actions` is not an array of strings, or whose `order` is not a finite number, fails the boot with `Hook <name> declares no valid actions/order`. The same check applies to the instance a factory registration returns.

- Declare `actions` and `order` as plain field initializers, or as getters with no dependencies.
- Define `before`, `after` and `failed` as class methods. A phase added to the instance later is never called.
- Keep the constructor free of side effects and of required arguments.
- Injected dependencies (`@Autoinject`) are available only inside `before`, `after` and `failed`.

## Shared state: `bag`

`ctx.bag` is one `Map<string, unknown>` shared by the `before`, `after` and `failed` calls of a single run. Set a value in `before`, read it in `after` or `failed`. It does not outlive the run and is not shared between runs.

## Depth

`ctx.depth` is `1` for a top-level run. A hook that runs another action (a `before` hook calling a users action) triggers that action's hooks with `depth + 1`. Past `hooks.maxDepth`, the run throws `ActionHookFailed` with reason `'depth'`.

## When hooks are collected

- Hook **types** are collected at boot. A hook registered after boot is not used.
- Hook **instances** of class registrations are resolved on the first run of an action they match that reaches a phase they define, not at boot. A factory registration (`() => instance`) is called at boot. A hook can inject a service that injects `Hooks` without a dependency cycle.

Import the module that registers your hook before the application boots.

## Logging

Hook failures are logged on the `hooks` log with the hook class name, the action and the error class. The error message and the input are never logged, since an input can hold a password.

The `refuse` message is not logged. It reaches the caller as `ActionRefused.message` (default `<action> refused: <code>`), so keep input values out of it. An action may map a refusal to its own answer (authn keeps opaque answers), so callers must not rely on seeing the message.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `hooks.timeoutMs` | integer | `5000` | 1 to 60000 | Time bound for one hook call, in milliseconds. |
| `hooks.maxDepth` | integer | `8` | 1 to 32 | Maximum nesting of action runs started from hooks. |

Any other key under `hooks` fails configuration validation, so a typo does not pass silently.

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
| Hooks | `Hooks` (abstract), singleton in the root container | `DefaultHooks` (`@Injectable(Hooks)`) | none | `DI.register(MyHooks).as(Hooks)`, before boot. |
| Action hooks | `ActionHook` (abstract), the type list is read at boot | none | any number | `@Injectable(ActionHook)` on your class, `DI.register(X).as(ActionHook)`, or a factory `() => instance`. Register before `Hooks` boots. |

## Important behaviour

- The `before` hook gets a **shallow** copy of the input, and `after` hooks get the live output. Only top-level keys are protected: a hook can still change nested data inside a non-mutable key (`ctx.input.user.Email = ...`) or inside the output, by reference. Do not mutate nested non-mutable data.
- `depth` and `hooks.maxDepth` count runs started from inside a hook. A run started by an action's own `impl` adds no level: it runs at that action's depth (`1` for a top-level action).
- Factory registrations (`register(() => hook).as(ActionHook)`) are called when `Hooks` boots, so a factory must not resolve services that inject `Hooks`. Class registrations are resolved lazily.
- With `refusable: false`, a `before` hook that times out is abandoned but still holds its `ctx`. Edits it makes to mutable keys of `ctx.input` after the timeout can still reach the merge; if it replaces `ctx.input` with a non-object, the runner uses the last valid input. Keep `before` hooks fast and cancel their own work.
- Hooks with a `before` are resolved one by one in `before` order. If a later hook fails to resolve, the `before` of earlier hooks has already run. Hooks with only `after` or `failed` are resolved when that phase reaches them, so a refused run never resolves them.
- A refusal counts only when made through `ctx.refuse` in that run. An `ActionRefused` thrown any other way (built by hand, or coming from a nested run) is treated as a hook error.
- With no matching hook, an action pays a lookup: `impl` gets the same input object and no context is built.
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
// Don't: user is not mutable, and the shallow copy still shares it with the caller
ctx.input.user.Email = ctx.input.user.Email.toLowerCase();

// Do: change a mutable key, by assigning a new value
ctx.input.data = { ...ctx.input.data, Email: ctx.input.data.Email.toLowerCase() };
```

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
const stamp = mutatingHook('orders.submit', { note: 'checked' });

// After a run: recorder.calls[0].phase === 'before'
```

Register a kit hook with `container.register(() => hook).as(ActionHook)` before `Hooks` resolves. `RecordingActionHook` matches `['*']` by default; pass patterns to its constructor to narrow it.

## Examples

### Block large orders and time the rest

```ts sample
import { Injectable } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';
import type { AfterContext, BeforeContext } from '@spinajs/hooks';

declare module '@spinajs/hooks' {
  interface HookActions {
    'orders.submit': {
      input: { customerId: string; total: number; note?: string };
      output: { id: string };
    };
  }
}

@Injectable(ActionHook)
export class OrderRulesHook extends ActionHook<'orders.submit'> {
  public readonly actions = ['orders.submit'] as const;

  public readonly order = 10;

  public before(ctx: BeforeContext<'orders.submit'>): void {
    if (ctx.input.total > 10_000) {
      ctx.refuse('order.over_limit');
    }

    ctx.bag.set('startedAt', Date.now());
    ctx.input.note = `${ctx.input.note ?? ''} [checked]`.trim();
  }

  public after(ctx: AfterContext<'orders.submit'>): void {
    const startedAt = ctx.bag.get('startedAt') as number;
    console.log(`order ${ctx.output.id} placed in ${Date.now() - startedAt} ms`);
  }
}
```

`note` reaches `orders.submit` only when that action lists it in `mutable`; see [Declaring actions](02-declaring-actions.md).

## Related

- [Declaring actions](02-declaring-actions.md): how an action exposes itself to hooks.
- [Multiple implementations](../di/06-multiple-implementations.md): how lists of services are registered.
