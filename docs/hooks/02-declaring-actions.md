# Declaring actions

A package makes an operation hookable by declaring it in `HookActions` and routing it through `Hooks.run`. Do this for operations whose callers need a rule or a notification: create, delete, change a password.

## How it works

1. You declare the action in `src/hooks.ts` with a module augmentation. This gives `InputOf` and `OutputOf` their types.
2. The action injects `Hooks` and, at its entry point, calls `Hooks.run(action, input, impl, { mutable, refusable })`.
3. `Hooks.run` runs the `before` hooks, then `impl` with the merged input, then the `after` hooks (or the `failed` hooks when `impl` throws). See [Writing a hook](01-writing-a-hook.md#how-it-works).
4. The action maps `ActionRefused` and `ActionHookFailed` to its own answer.

## Declaring an action

Each package adds its actions to the `HookActions` interface, in its `src/hooks.ts`:

```ts
declare module '@spinajs/hooks' {
  interface HookActions {
    'orders.create': { input: PlaceInput; output: PlaceOutput };
  }
}
```

- The key is the action name. Use dotted names (`orders.create`, `orders.item.add`) so prefix patterns like `'orders.*'` work.
- `input` is what hooks see. Leave out secrets such as plaintext passwords.
- `output` is what `after` hooks see. A failure result (`status: 'failure'`) is an output, not an error.

## Running an action

```ts
Hooks.run(action, input, impl, { mutable, refusable })
```

| Argument | Meaning |
| --- | --- |
| `action` | The action name. |
| `input` | The input object; hooks get a shallow copy. |
| `impl` | `(input) => Promise<output>`. It receives the merged input. |
| `opts.mutable` | The input keys a `before` hook may change. `[]` for none. Later `before` hooks see the other keys unchanged. |
| `opts.refusable` | Default `true`. `false`: a refusal or an error in `before` is logged and `impl` runs anyway. The depth limit (`hooks.maxDepth`) is always enforced, even with `false`. |

### The zero-cost path

`run()` checks the cached match first. With no matching hook it returns `impl(input)` with the same input object and builds no context.

`Hooks.has(action)` is `true` when at least one registered hook matches. Use it to skip work that only hooks need, such as assembling a large input.

## Mapping errors

`run()` can throw two errors of its own. Map both to the action's usual answer, so its callers see the shape they have today.

| Error | Meaning | Fields |
| --- | --- | --- |
| `ActionRefused` | A `before` hook called `ctx.refuse`. | `action`, `code`, `message` |
| `ActionHookFailed` | A `before` hook threw something else, timed out, or the run passed `hooks.maxDepth`. | `action`, `hook` (class name; for `'depth'`, the first matching hook), `reason`: `'error'`, `'timeout'` or `'depth'` |

- Map a refusal to a failure the caller already handles.
- Where the action answers the same for every account (a reset request, say), answer the same when refused. Only the audit tells.
- Audit the real reason: `hook:<code>` for a refusal, `hook_error` for `ActionHookFailed`.
- An error thrown by `impl` is not mapped: the `failed` hooks see it and it is rethrown unchanged.

## Security invariants

A hook can narrow an action, never widen it.

- Run the action's own security checks **before** `Hooks.run`.
- Run again, inside the action's own `impl`, on the values a hook changed, the checks that guard each mutable key.
- Declare in `mutable` only the keys you check again.
- Revocations that follow from a security event (a ban, a deactivation, a delete, a password expiry revoking sessions, a back-channel logout, a token self-revocation) are not refusable. Pass `refusable: false` for an action that must complete.

## Example: a hookable action

```ts sample
import { Autoinject } from '@spinajs/di';
import { ActionHookFailed, ActionRefused, Hooks } from '@spinajs/hooks';

declare module '@spinajs/hooks' {
  interface HookActions {
    'orders.create': {
      input: { customerId: string; total: number; note?: string };
      output: { id: string };
    };
  }
}

export type PlaceResult =
  | { status: 'placed'; id: string }
  | { status: 'refused'; code: string }
  | { status: 'unavailable' };

export class OrderService {
  @Autoinject(Hooks)
  protected Hooks: Hooks;

  public async place(input: { customerId: string; total: number; note?: string }): Promise<PlaceResult> {
    this.assertTotal(input.total);

    try {
      const out = await this.Hooks.run('orders.create', input, (merged) => this.insert(merged), {
        mutable: ['note'],
      });
      return { status: 'placed', id: out.id };
    } catch (e) {
      if (e instanceof ActionRefused) {
        return { status: 'refused', code: e.code };
      }
      if (e instanceof ActionHookFailed) {
        return { status: 'unavailable' };
      }
      throw e;
    }
  }

  protected assertTotal(total: number): void {
    if (!(total > 0)) {
      throw new Error('total must be positive');
    }
  }

  protected async insert(input: { customerId: string; total: number; note?: string }): Promise<{ id: string }> {
    return { id: `${input.customerId}-${Date.now()}` };
  }
}
```

Only `note` is mutable, so the `total` check before the hooks still holds afterwards. Had `total` been mutable, `insert` would call `assertTotal` again.

## Important behaviour

- Hooks get a shallow copy of the input and the live output. Only top-level keys are protected: a hook can change nested data inside a non-mutable key, or inside the output, by reference. Do not rely on nested data being untouched, and re-check invariants inside `impl`.
- A run started by an action's own `impl` adds no level: it runs at that action's depth (`1` for a top-level action). `hooks.maxDepth` limits only runs started from inside a hook.
- Hook types are read at boot and instances resolve on the first matching run, bounded by `hooks.timeoutMs`. A hook whose `actions` or `order` is invalid fails the boot. The action injects `Hooks` like any service.
- A hook that runs another action raises `depth`. The runner enforces `hooks.maxDepth`, so the action needs no loop guard.
- Hook failures are logged with the hook class, the action and the error class, never the input.

## Best practices

- Put the `declare module` block in the package's `src/hooks.ts` and export the input and output types, so hook authors can import them.
- Call `Hooks.run` once per action, around the whole operation.
- Document the action name, its mutable keys, whether it is refusable and the refused answer, so hook authors know the contract.

## Related

- [Writing a hook](01-writing-a-hook.md): the contract hook authors implement.
- [Hook configuration](01-writing-a-hook.md#configuration): `hooks.timeoutMs` and `hooks.maxDepth`.
- [`@spinajs/di`](../di/README.md): `@Autoinject` for the `Hooks` service.
