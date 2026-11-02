# Typed tokens

A token is a string key that carries a TypeScript type. `DI.resolve(MAILER)` returns a `Mailer`, not `unknown`, and the compiler and `spinajs doctor` read the key as they read any string registration.

Use one for a value or service that has no class to key on: a settings object, a factory result, an interface (which is erased at runtime). It does **not** add a new kind of registration: a token is the existing string key plus a type, so string and token lookups of one key see the same registrations.

## How it works

```ts
import { DI, token } from '@spinajs/di';

export interface Mailer {
  send(to: string, subject: string): Promise<void>;
}

export const MAILER = token<Mailer>('app.mailer', 'sends transactional mail');

class SmtpMailer implements Mailer {
  public async send(to: string, subject: string) {
    /* ... */
  }
}

DI.register(SmtpMailer).asToken(MAILER);

const mailer = DI.resolve(MAILER); // Mailer
await mailer.send('a@example.com', 'Hello');
```

1. `token<T>(key, description?)` returns a frozen `{ key, description? }` object marked with a registry symbol (`Symbol.for('@spinajs/di/token')`).
2. `asToken(token)` registers under `token.key`. It is `as(token.key)`.
3. `resolve`, `get`, `hasRegistered`, `isResolved`, `resolveOptional` and the root helpers `DI.resolve`, `DI.get`, `DI.has` and `DI.check` accept a token wherever they accept a string, and map it to `token.key`. The result is typed by the token's parameter.

## API

| Export | Meaning |
| --- | --- |
| `token<T>(key, description?)` | Makes a `Token<T>` |
| `Token<T>` | `{ readonly key: string; readonly description?: string; readonly __type?: T }`. `__type` exists for inference only and is never set |
| `isToken(value)` | `true` only for values made by `token()`, also by another installed copy of `@spinajs/di` (the marker is a registry symbol). An object that merely has a `key` string is not a token |
| `keyOf(value)` | The string key of a token, any other argument unchanged |
| `IBind.asToken(token, options?)` | Registers the bound class, factory or value under `token.key`; `options` are the `as()` options |
| `getTypeName(token)` | `token.key` |

Inference of the result type, from the type tests of the package:

| Call | Type |
| --- | --- |
| `DI.resolve(GREETER)` | `Greeter` |
| `DI.get(GREETER)` | `Greeter \| undefined` |
| `DI.RootContainer.resolveOptional(GREETER)` | `Greeter \| undefined` |
| `DI.resolve(T, [7])` | The same type; the array is passed to the constructor or factory as with a class |

## Behaviour

- **A token and a string are the same key.** `DI.register(Greeter).asToken(GREETER)` is found by `DI.resolve('app.greeter')`, and `DI.register(Greeter).as('app.greeter')` by `DI.resolve(GREETER)`. A plain value stored with `asValue(GREETER.key)` is read with `DI.get<T>(GREETER.key)`.
- **Child containers** resolve a token through the parent chain as they do a string.
- **The type is a promise you make.** Nothing checks at runtime that what is registered under the key is a `T`; the parameter exists for the caller.
- **Keep the key unique.** Two tokens with one key are one registration, whatever their types.
- The framework uses tokens itself: `PROPERTY_TYPE_RESOLVER` (`__property_type_resolver__`) is `token<IPropertyTypeResolver>(...)`.

## What the compiler and doctor do with tokens

The analyzer follows a token constant to its string key, so a manifest does not care whether a service was registered by token or by string.

| Where the token appears | Recorded |
| --- | --- |
| `DI.register(X).asToken(T)` | `registeredAs` of the service holds the key of `T` |
| `DI.register(value).asToken(T)`, `asValue(T.key)` | A `ValueEntry` with `token` set to the key |
| `@Inject(T)` on a class | The key, among the service's constructor injections |
| `DI.resolve(T)` in a service | An imperative resolve of the key (with whether it was awaited) |
| An ordinary identifier, such as a class name | Its own name, as before |

The key is followed through imports, re-exports and `T.key`, and for a token declared in a workspace package's `.d.ts` through its declaration map to the original source. With the key recorded, doctor rules `DI001` (an injected token nothing registers), `DI002` (cycles) and `DI003` (async into sync) work on tokens as on strings.

A key that cannot be read (no declaration map, a malformed map, a missing source, a key that is not a literal string) is recorded as the reserved key `token:unresolved:<module>#<export>`, and the build emits warning `CMP005` naming the step that failed. Doctor skips such a key in `DI001`, `DI002` and `DI003`, so an unreadable token never reports a false problem and never becomes a name made from the constant. To make a key readable, declare it with a string literal (or a constant expression of literals) in the `token()` call:

```ts
export const CACHE = token<Cache>('app.cache'); // readable
export const OTHER = token<Cache>(computeKey()); // CMP005, token:unresolved:...
```

In the compiler's `tokens` fixture, an `@Inject(MAILER as never)` argument is read as a token; the `as never` is there because the decorator's signature takes classes and typed arrays. That constructor form is the only decorator that injects a token: `@Autoinject(T)` reads the token object as its options, so inject a token through the constructor, or resolve it with `DI.resolve(T)`.

## Related

- [Registering services](01-registering-services.md): `as`, `asValue` and the key rules.
- [Resolving services](02-resolving-services.md): `resolve`, `get` and `resolveOptional`.
- [Values and value maps](09-values-and-value-maps.md): `asValue` under a token's key.
- [spinajs doctor](../compiler/doctor.md): `DI001` to `DI003`.
- [Compiler diagnostics](../compiler/README.md#diagnostics): `CMP005`.
