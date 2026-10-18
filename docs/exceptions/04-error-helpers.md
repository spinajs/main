# Error helpers

Five functions for a caught value of unknown type: name it in a log without its message, describe it, turn it into an `Error`, and test its class across two copies of a package. None of them throws, whatever the value is (a Proxy, a throwing getter, `null`).

```ts
import { describeError, errorClassOf, errorMessage, isErrorOf, toError } from '@spinajs/exceptions';
```

## Reference

| Function | Returns |
| --- | --- |
| `errorClassOf(err)` | The class of an `Error`: its `name`, or the constructor name when `name` is the generic `'Error'` (an `Exception` subclass that does not set `name`). A non-Error gives its `typeof`, and `'null'` for `null`. |
| `errorMessage(err)` | The `message` of an `Error`, a string as is, any other primitive through `String()`. Any other object gives only its tag, `[object Object]`, never its contents or its own `toString()`. `'unprintable error'` when reading the value throws. |
| `describeError(err, { withClass? })` | `errorMessage(err)` prefixed by `errorClassOf(err)` for an `Error`: `TypeError: boom`, or `TypeError` alone for an empty message. `withClass: false` gives the message alone. A non-Error never gets a prefix. |
| `toError(err)` | `err` itself when it is an `Error`; otherwise `new Error(errorMessage(err))`. The original value is not kept, not even as `cause`. |
| `isErrorOf(err, Class)` | `true` when `err instanceof Class`, or when a class named like `Class` sits on `err`'s prototype chain. |

## Important behaviour

- `errorClassOf` is the one to log where the message may echo a secret, such as the credential that made a strategy throw.
- `describeError` has two formats on purpose: `Name: message` (the default) for logs and fault reasons, the message alone (`withClass: false`, or `errorMessage`) for text that already names the failure.
- `isErrorOf` matches by class name the way the `@spinajs/http` error mapping does, so an error thrown by the cjs build of a package matches the class imported from its mjs build. It matches subclasses, also across copies. It does not match on an `err.name` field: a plain `Error` whose `name` is set to `'InvalidOption'` is not an `InvalidOption`.
- Two unrelated classes with the same name match each other in `isErrorOf`. A minifier that renames classes breaks the name match; `instanceof` still works within one copy.

## Patterns and antipatterns

```ts
// Don't: the message of a refused credential can reach the log
log.warn({ error: (err as Error).message }, 'login failed');

// Do: log the class only
log.warn({ errorClass: errorClassOf(err) }, 'login failed');

// Don't: false for an InvalidOption thrown by the other build of the package
if (err instanceof InvalidOption) throw err;

// Do
if (isErrorOf(err, InvalidOption)) throw err;
```
