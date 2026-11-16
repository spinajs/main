# Client models

The generated client returns what the server sent: a date is a string, a decimal is a string, a relation is a plain object. With `--models` the client converts replies into the types your app uses (`Date`, luxon `DateTime`, decimal.js `Decimal`, your own classes) and converts the same values back when you send them.

Nothing changes until you ask for it. Without `formats` and `models`, `createAppClient` returns the plain `AppClient` and converts nothing, with or without `--models`.

## Turning it on

Generate with the `models` option of `generateClientFiles`. A `--models` flag for `spinajs generate:client` comes with that command's flag task (FG-2) and does not exist yet:

```ts
import { generateClientFiles } from '@spinajs/client';

const files = await generateClientFiles({ manifest, models: true });
```

`client.ts` then gains, next to the 4.0 declarations:

- `<Dto>Model<F, M>`, the converted shape of each DTO that has something to convert, where `F` maps a format to your type and `M` maps a DTO to your model type;
- `AppModelClient<F, M>`, the client with those shapes, and an overload of `createAppClient` that takes `formats` and `models`;
- the conversion plans the runtime walks. They are data, not code, so the generated file stays small.

```ts
import { createAppClient } from './generated/client.js';
import { dateCodec, fromClass } from '@spinajs/client/runtime';
import { User } from './user.js';

export const api = createAppClient({
  baseUrl: 'https://api.example.com',
  formats: { 'date-time': dateCodec },
  models: { UserDto: fromClass(User) },
});

const user = await api.users.get(7); // User, with user.createdAt as a Date
```

Pass `formats` and `models` as object literals, or add `as const` to a variable that holds them. The types are inferred from the literal: an object typed as `FormatCodecs` or `Partial<Record<DtoName, ModelEntry<unknown>>>` loses them, and the replies fall back to wire types while the runtime still converts.

## Formats and codecs

A codec converts the wire value of one schema format:

```ts
interface Codec<T> {
  decode(wire: unknown): T;
  encode(value: T): unknown;
}
```

The slots are:

| Slot | Schema | Wire type | Default app type |
| --- | --- | --- | --- |
| `date-time` | `format: 'date-time'` (a `Date` or a luxon `DateTime` on the server) | ISO 8601 text with an offset | `string` |
| `date` | `format: 'date'` | `YYYY-MM-DD` | `string` |
| `decimal` | `format: 'decimal'` (a decimal.js `Decimal`, a big.js `Big`, or `@format decimal`) | plain decimal text | `string` |
| `int64` | `x-spinajs-type: 'bigint'` | integer text | `string` |

A slot with no codec keeps its wire type, so you convert only what you register. A string field tagged `@format decimal` uses the `decimal` slot as well, although its server type is a plain `string` and its schema has no `x-spinajs-type`.

`@spinajs/client/runtime` ships `dateCodec` (`Date`, ISO text). The codecs for libraries are in `@spinajs/client/codecs`. They take the library as an argument and import no package (only types from the runtime), so `@spinajs/client` depends on neither luxon, decimal.js nor big.js, and your bundle contains only the library you already use:

```ts sample
import { Big } from 'big.js';
import { Decimal } from 'decimal.js';
import { DateTime } from 'luxon';
import { bigintCodec, decimalCodec, luxonCodec, luxonDateCodec } from '@spinajs/client/codecs';

export const formats = {
  'date-time': luxonCodec(DateTime),
  date: luxonDateCodec(DateTime),
  decimal: decimalCodec(Decimal), // decimalCodec(Big) for big.js
  int64: bigintCodec,
} as const;

export const price: Big = decimalCodec(Big).decode('12.50');
```

| Codec | App type | Encodes with |
| --- | --- | --- |
| `luxonCodec(DateTime)` | `DateTime`, keeping the offset of the text | `toISO()` |
| `luxonDateCodec(DateTime)` | `DateTime` at the start of the day; refuses text with a time | `toISODate()` |
| `decimalCodec(Decimal)` / `decimalCodec(Big)` | `Decimal` / `Big` | `toFixed()` |
| `bigintCodec` | `bigint` | `toString()` |

Decoding text a codec cannot read throws `TypeError`. A value that is not of the codec's type is sent as it is, so the server answers with its own 400.

### Decimals: write `toFixed()`, never `toJSON()`

The server's `decimal` format accepts plain decimal text only: `12.50`, `-0.5`, never `1e+21`. decimal.js and big.js switch to exponent notation from `toJSON()` and `toString()` at or beyond their thresholds, and a body written with `JSON.stringify` then gets a 400:

| Library | Exponent notation below | and at or above | Global switch |
| --- | --- | --- | --- |
| decimal.js | `toExpNeg` = -7 (`1e-7`) | `toExpPos` = 21 (`1e+21`) | `Decimal.set({ toExpNeg: -9e15, toExpPos: 9e15 })` |
| big.js | `Big.NE` = -7 | `Big.PE` = 21 | `Big.NE = -1e6; Big.PE = 1e6` |

`decimalCodec` encodes with `toFixed()`, which never uses exponent notation, so it needs no global change. It refuses `NaN`, `Infinity` and hex text on decode, and a `NaN` or `Infinity` value on encode, with a `TypeError`. It recognises a value by its `toFixed()` method, so a value from `Decimal.clone()` or a second copy of the library is encoded as well. Write your own codec the same way:

```ts sample
import { Decimal } from 'decimal.js';
import type { Codec } from '@spinajs/client/runtime';

export const money: Codec<Decimal> = {
  decode: (wire) => new Decimal(String(wire)),
  encode: (value) => (value instanceof Decimal ? value.toFixed() : value),
};
```

The same applies to a decimal argument. A `Decimal` that no codec handles travels through `String()` in a path or header argument, which writes exponent notation, and makes a **query** argument throw `TypeError`, because a query value cannot be an object. Register the codec and both work.

### Types of the format slots

`FormatTypes` turns a map of codecs into the map of app types the generated `<Dto>Model` types read:

```ts sample
import { dateCodec, type FormatTypes } from '@spinajs/client/runtime';

export type AppFormats = FormatTypes<{ 'date-time': typeof dateCodec }>;
```

Do not write the map by hand as `{ 'date-time': Date }`. A partial map types every slot you leave out as `unknown`, with no error. `FormatTypes` fills them with the wire types.

## Registering models

A model entry is `{ decode, encode? }`. `fromClass(User)` is the usual one: it creates `new User()` and copies the decoded keys onto it.

```ts
interface ModelEntry<T> {
  decode(value: Record<string, unknown>): T;
  encode?(model: T): Record<string, unknown>;
}
```

- `decode` receives the DTO after its dates and other formats were converted, and with nested DTOs already converted (and already models, when you registered those).
- `fromClass` copies the keys of the reply onto `new User()`: through the class's setter where it has one (a class may implement a declared property as a getter and setter pair, and the setter receives the decoded value), never over a method or a getter without a setter. It skips `__proto__`, `constructor` and `prototype`.
- Models are registered by DTO name. Only DTOs that are objects, records or unions can have one; the generated `DtoName` type lists them, and a key outside it is a compile error.

Keep the app class and the generated shape in step by merging them. With `--models` the class merges with `<Dto>Model<AppFormats, AppModels>`, the converted shape, not with the wire interface `<Dto>`:

```ts sample
import { dateCodec, fromClass, type FormatTypes, type FormatSlots, type ModelEntry, type NoEntries } from '@spinajs/client/runtime';

type AppFormats = FormatTypes<{ 'date-time': typeof dateCodec }>;

// In the app this comes from './generated/client.js'.
interface UserDtoModel<F extends FormatSlots = FormatTypes<{}>, _M = NoEntries> {
  id: number;
  email: string;
  name?: string;
  createdAt: F['date-time'];
}

export interface User extends UserDtoModel<AppFormats> {}
export class User {
  get label(): string {
    return this.name ?? this.email;
  }

  get isNew(): boolean {
    return Date.now() - this.createdAt.getTime() < 86_400_000;
  }
}

export const users: ModelEntry<User> = fromClass(User);
```

For a DTO with relations, pass the models too: `ArticleDtoModel<AppFormats, AppModels>` types `article.author` as `User` when `AppModels` has `UserDto: ModelEntry<User>`. Registered models apply recursively, in replies and in arguments.

### Arguments use the model types

With a model registered, a method that takes that DTO takes the model: `users.create(body: User)` once `CreateUserDto` has a model, and `since(from: Date)` once `date-time` has a codec. A body you build as an object literal must satisfy the class, getters included. Send back what you got and it type-checks.

## Sending models back

When `formats` or `models` is set, every argument that came from a schema is encoded before it is bound:

1. A registered model's `encode` runs, else `toJSON()` when the object has one.
2. Codecs encode their values (`Date` to ISO text, `Decimal` to `toFixed()`).
3. A **closed** object is projected onto the properties its schema declares. Class getters, caches and fields the class added never reach the server.

The projection matters because the server rejects extra properties of a closed object with a 400 (`docs/http/04-route-arguments.md`). Without it, a field a model class adds would turn a valid request into a failure.

- Path and header arguments are text: a `Date` travels as ISO text, and any other value through `String()`. A query value must be a primitive or a `Date`: an object such as a luxon `DateTime` or a `Decimal` makes the call throw `TypeError`, so register its codec.
- The top level of a request body is the exception on the server: a root-level extra key is accepted and dropped there. Nested closed objects are where the 400 happens, so they are where the projection counts.
- A file argument and a splat argument are never touched.

## Unions

A union converts only when the client can tell which member it holds.

- **Discriminated unions convert.** With an `x-discriminator` mapping, the tag picks the member and so its model. Prefer discriminated unions for anything you register a class for.
- **A tag can be inferred.** If one property is a required literal in every member but at most one, and that one member is a closed object, the generator uses it as the discriminator. `UserDto | ValidationProblem` is told apart by `kind` (declared by `ValidationProblem` only), and a reply without `kind` is a `UserDto`. The reply type of `users.create` therefore becomes `User | ValidationProblem`.
- **Anything else keeps its wire type** and converts nothing, unless every member needs the same conversion: the generated type stays `string | number` or the plain DTO union, and encode does not project it either. A union you cannot discriminate cannot hold a model class, because no model runs for it.
- **An unknown tag converts nothing.** A newer server that adds a member the client does not know gives a value that passes through as received, while the type still claims the known members. Regenerate when the server changes.

Tuples, `patternProperties`, enum DTOs and `const` values are not converted either.

## Bigint and hook variables

A `bigint` value in the query variables of a generated hook breaks TanStack Query's key hashing, which cannot serialise `bigint`. With `bigintCodec` registered, a route that takes an `int64` argument types it as `bigint`: pass it to hooks as a string, or convert it before it reaches the variables.

## Failure modes

- **One bad value rejects the whole reply.** Decoding runs after a 2xx reply is parsed. A codec that throws (a date that is not ISO text, a decimal that is not a number) makes the call reject with `TypeError`, and no partial result is returned. The request itself already succeeded on the server.
- **Unknown fields pass through.** A reply from a newer server keeps keys the DTO does not declare. For a closed object a model's `decode` receives declared keys only; for an open one it receives every key.
- **Nested plain objects keep every own key,** including data keys named `__proto__` or `constructor` that arrive in JSON. They are own data properties, never setters. A model class is safe through `fromClass`; a hand-written `decode` that copies keys with `Object.assign` or a spread into a class instance is not (below).

## `Object.assign` and `__proto__`

`JSON.parse('{"__proto__": {"isAdmin": true}}')` creates an own key named `__proto__`. `Object.assign(new User(), dto)` assigns it, which runs the `__proto__` setter and replaces the instance's prototype with the reply's object. The same happens with any loop of `target[key] = value`.

Use `fromClass(User)`, which defines the keys instead of assigning them. In a hand-written `decode`, copy only the keys you know, by name.

## Relation to ORM models

A `ModelBase` subclass is server code: it imports the ORM, DI and the driver converters, and must never enter a browser bundle. The client does not generate or import it.

What the client gets from an ORM model is its derived schema: the columns that are not `@Hidden`, computed members, relations as optional references or arrays (a relation is in the reply only when it was populated), and `@DateTime()` columns as `format: 'date-time'` with `x-spinajs-type: 'DateTime'`. Register a client class for the DTO name (`ArticleDto`) as for any other DTO, and `article.author` becomes a client `User` when `UserDto` is registered.

`x-spinajs-type` records which server type produced a schema (`Date`, `DateTime`, `Decimal`, `bigint`). Conversion follows `format` and, for `bigint`, the `int64` slot. Use `DateTime` as the hint to register a luxon codec where the server used luxon. Register it for every `DateTime` argument: without a codec a `DateTime` in a query throws,, and in a body it is written by `JSON.stringify`.

See [Extending generated types](README.md#extending-generated-types) for the hand-written alternatives.
