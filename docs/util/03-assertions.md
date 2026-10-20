# Assertions

Runtime assertions with TypeScript `asserts` signatures: after a passing call the compiler narrows the type. Use them inside a function body when a value must be present or of a type and a failure is a programming or input error.

## How it works

1. Call the assertion with the value, an optional `name` for the message, and an optional custom `Error`.
2. When the value matches, the call returns nothing and TypeScript narrows the variable's type for the rest of the scope.
3. When it does not match, the call throws the custom `error` if given, otherwise the default exception below.

| Function | Passes when | Narrows to | Default error | Error code |
| --- | --- | --- | --- | --- |
| `assert(condition, error)` | `condition` is true | `condition` holds | `InvalidOperation(error)` for a string, or `error` itself | |
| `assertNonNull(value, name?, error?)` | `value !== null` | `T` | `InvalidArgument` | `NULL_VALUE` |
| `assertNonNil(value, name?, error?)` | not `null` and not `undefined` | `NonNullable<T>` | `InvalidArgument` | `NULL_VALUE` |
| `assertString(value, name?, error?)` | `typeof value === 'string'` | `string` | `InvalidArgument` | `TYPE_MISMATCH` |
| `assertNonEmptyString(value, name?, error?)` | a string of length > 0 | `string` | `InvalidArgument` | `EMPTY_VALUE` |
| `assertNumber(value, name?, error?)` | a number that is not `NaN` | `number` | `InvalidArgument` | `TYPE_MISMATCH` |
| `assertArray<T>(value, name?, error?)` | `Array.isArray(value)` | `T[]` | `InvalidArgument` | `TYPE_MISMATCH` |
| `assertObject(value, name?, error?)` | a non-null object that is not an array | `Record<string, unknown>` | `InvalidArgument` | `TYPE_MISMATCH` |

Without `name`, the message and `fieldName` use `value`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| The error an assertion throws | Not registered in DI; an argument | `InvalidOperation` or `InvalidArgument` | Any `Error` subclass | Pass it as the last argument, eg. an HTTP exception so the failure maps to a status code |

## Important behaviour

- `assertNumber` rejects `NaN`; `_is_number` in [argument validation](01-argument-validation.md) accepts it.
- `assertObject` accepts class instances, `Map`, `Date` and any other non-array object.
- `assertArray<T>` narrows to `T[]` without checking the elements.
- `asserts` narrowing needs an explicit type on the function reference. Call the imported function directly; do not assign it to an untyped `const` first.

## Best practices

- Use assertions for invariants inside a function; use `_check_arg` at a boundary where you also want to normalize the value.
- Pass a domain exception as `error` when the caller handles it, eg. `Forbidden` from `@spinajs/exceptions` for a missing session user.

## Examples

### Narrow optional values before use

```ts sample
import { Forbidden } from '@spinajs/exceptions';
import { assert, assertNonNil, assertNumber } from '@spinajs/util';

interface Session {
  user?: { id: number; isActive: boolean };
}

function requireActiveUserId(session: Session): number {
  assertNonNil(session.user, 'user', new Forbidden('login required'));
  assert(session.user.isActive, 'user must be active');
  return session.user.id;
}

function circleArea(radius: unknown): number {
  assertNumber(radius, 'radius');
  return Math.PI * radius ** 2;
}

console.log(requireActiveUserId({ user: { id: 7, isActive: true } }), circleArea(2));
```

## Related

- [Argument validation](01-argument-validation.md): composable checks that validate and transform.
- [`@spinajs/exceptions`](../exceptions/README.md): `InvalidArgument`, `InvalidOperation` and the HTTP exceptions to pass as `error`.
