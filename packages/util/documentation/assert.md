# Assertions (`assert`)

Runtime assertions that double as **TypeScript type guards** (`asserts` signatures) — after a passing assert, the compiler narrows the type. Failures throw `@spinajs/exceptions` errors.

```ts
import { assert, assertNonNil, assertString, assertNumber } from '@spinajs/util';
```

## `assert(condition, error)`

Throws `InvalidOperation` (for a string message) or the given `Error` when `condition` is false:

```ts
assert(user.isActive, 'user must be active');
assert(items.length > 0, new EmptyCartError());
```

## Value assertions

Each throws `InvalidArgument` (with `fieldName` + `errorCode`) unless the value matches, and narrows the type on success. All take an optional `name` (for the message) and an optional custom `error`.

| Function | Guarantees / narrows to |
|---|---|
| `assertNonNull(v, name?)` | not `null` |
| `assertNonNil(v, name?)` | not `null` **or** `undefined` → `NonNullable<T>` |
| `assertString(v, name?)` | `string` |
| `assertNonEmptyString(v, name?)` | non-empty `string` |
| `assertNumber(v, name?)` | `number` (rejects `NaN`) |
| `assertArray(v, name?)` | `T[]` |
| `assertObject(v, name?)` | plain object (not array/null) |

```ts
function greet(name: string | undefined) {
  assertNonNil(name, 'name');
  // name is `string` here — no more `| undefined`
  return `Hello, ${name.toUpperCase()}`;
}

function area(input: unknown) {
  assertNumber(input, 'radius');
  return Math.PI * input ** 2; // input is `number`
}
```

## Custom errors

Pass your own `Error` to control what is thrown:

```ts
import { Forbidden } from '@spinajs/exceptions';

assertNonNil(session.user, 'user', new Forbidden('login required'));
```

## `assert` vs. `args`

- **`assert*`** — imperative guards that narrow a type inline. Reach for these inside a function body.
- **[`args`](./args.md)** — composable validators that also **transform/coerce**. Reach for these to validate & normalize inputs at a boundary.
