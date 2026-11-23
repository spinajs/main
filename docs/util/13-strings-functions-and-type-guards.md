# Strings, functions and type guards

Small helpers for strings, dates, deferred, cached and maybe-async function calls, type guards that narrow `unknown` values, and readers that pull typed fields out of untyped data.

## How it works

### Strings

| Function | Behaviour |
| --- | --- |
| `trimChar(s, char)` | Removes `char` from both ends: `trimChar('__x__', '_')` is `'x'` |
| `capitalize(s)` | Upper-cases the first character |
| `capitalizeWords(s)` | Capitalizes every whitespace-separated word, keeping the original spacing |
| `truncate(s, length, suffix = '…', { codePoints? })` | At most `length` characters, suffix included: `truncate('the quick brown fox', 9)` is `'the quic…'`. With `codePoints: true` it counts code points and never splits a surrogate pair |
| `truncateWords(s, count, suffix = '…')` | At most `count` words: `truncateWords('the quick brown fox', 2)` is `'the quick…'` |
| `isNullOrWhitespace(s)` | `true` for `null`, `undefined`, `''` and whitespace only |
| `asciiLower(s)` | Lower-cases `A`-`Z` only. `toLowerCase` also folds some non-ASCII letters to ASCII (the Kelvin sign U+212A becomes `k`), so use this for identifiers such as e-mail addresses |
| `escapeHtml(s)` | Escapes `& < > " '` as numeric character references, for HTML text and quoted attributes |
| `compareStrings(a, b)` | UTF-16 code-unit order, the order of `sort()` without a comparator |
| `compareCodePoints(a, b)` | Unicode code-point order (UTF-8 byte order); differs from `compareStrings` only for characters above U+FFFF against U+E000-U+FFFF |
| `quote(v)` | A value for an error message: strings JSON-quoted, anything else through `String`; never throws |
| `describeValue(v)` | A short, safe description of an unknown value: strings quoted and cut to 64 code points, `array(n)`, `object` or the class name; runs no getter or `toString` of the value |

### Dates

| Function | Behaviour |
| --- | --- |
| `toEpochMs(v)` | Milliseconds of a valid `Date`, also one from another realm (read through `Date.prototype.getTime`); `undefined` for an invalid Date or anything else |
| `isValidDate(v)` | Type guard: a `Date` from any realm that holds a time |
| `parseIsoInstant(text, { dateOnly? })` | Strict ISO 8601 instant: `YYYY-MM-DDThh:mm[:ss[.fraction]]` with `Z` or `±hh:mm`. A time needs a zone, and every field must be in range, so `2026-02-30`, `24:00` and `:60` give `undefined` instead of rolling over. `dateOnly: true` also reads `YYYY-MM-DD` as UTC midnight. Fractions past milliseconds are truncated |

### Maybe-async values

`MaybePromise<T>` is `T | Promise<T>`. These helpers keep a code path synchronous while every input is, instead of paying a microtask per step as `await` does.

| Function | Behaviour |
| --- | --- |
| `thenMaybe(value, next)` | `next(value)` right away, or once `value` resolves when it is a promise or another thenable |
| `allMaybe(values)` | The values themselves when none is a thenable, else `Promise.all(values)` |

### Functions

| Export | Behaviour |
| --- | --- |
| `Lazy<T>` | Wraps a callback; `call(context)` runs it with `this = context` on every call. Create with `new Lazy(cb)` or `Lazy.oF(cb)` |
| `once(fn)` | Runs `fn` on the first call and returns that result on every later call |
| `memoize(fn, keyFn = identity)` | Caches results of a one-argument function in a `Map` by `keyFn(arg)` |
| `noop()` | Does nothing |
| `identity(value)` | Returns `value` |

### Type guards

| Guard | `true` for |
| --- | --- |
| `isPromise(v)` | A native `Promise` only (`instanceof Promise`) |
| `isThenable(v)` | Any object or function with a callable `then`: promises from other realms or libraries, and awaitable objects |
| `isDefined(v)` | Not `null` and not `undefined`; narrows to `T`, so `list.filter(isDefined)` drops nils from the type |
| `isFunction(v)` | `typeof v === 'function'`, classes included |
| `isNonEmptyString(v)` | A string other than `''` |
| `isStringArray(v, { nonEmpty? })` | An array of strings; with `nonEmpty: true` no element may be `''` (an empty array still matches) |
| `isFiniteNumber(v)` | A number other than `NaN` and `±Infinity` |
| `isNonNegativeInt(v)` | A safe integer `>= 0` |

### Readers for untyped data

Each reader returns the value when it has the expected shape, otherwise `undefined`. Chain them with `?.` to read optional fields of parsed JSON, such as `EXPLAIN` output, without casts.

| Function | Returns |
| --- | --- |
| `asPlainObject(v)` | `v` when it is a non-null object that is not an array, otherwise `undefined` |
| `asString(v)` | `v` when it is a string, `''` included, otherwise `undefined` |
| `toFiniteNumber(v)` | A finite number from a number or a numeric string, surrounding whitespace allowed: `' 12.25 '` gives `12.25`, `'1e3'` gives `1000`. A blank string, `'12 rows'`, `NaN`, `±Infinity` (also `'Infinity'`) and any other type give `undefined` |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `memoize` cache key | Argument `keyFn` | `identity` | Any key function | Pass `keyFn` when the argument is an object: cache by its id instead of its reference |
| `Lazy<T>` | Class, built with `new` | | A subclass | Subclass it; `callback` is `protected` and `call(context)` is public |

### Cache by a derived key

```ts sample
import { memoize, once } from '@spinajs/util';

type Product = { sku: string; price: number; vatRate: number };

const grossPrice = memoize(
  (p: Product) => Math.round(p.price * (1 + p.vatRate) * 100) / 100,
  (p) => `${p.sku}:${p.price}:${p.vatRate}`,
);

const loadVatTable = once(() => new Map([['PL', 0.23], ['DE', 0.19]]));

const p: Product = { sku: 'SKU-1', price: 100, vatRate: loadVatTable().get('PL')! };
console.log(grossPrice(p), grossPrice({ ...p }), loadVatTable() === loadVatTable()); // 123 123 true
```

## Important behaviour

- `isPromise` is strict on purpose. Awaitable query builders expose `then`, and calling it runs the query; `@spinajs/di` uses `isPromise` to decide whether to await a resolved value. Use `isThenable` when foreign promises must match too.
- `once` does not count a call where `fn` throws: the error propagates and the next call runs `fn` again.
- `memoize` never evicts entries, and it caches a rejected promise like any other result.
- `Lazy.call` runs the callback every time; it does not cache. Combine it with `once` for a lazily computed value.
- `truncateWords` joins the kept words with single spaces when it truncates; it returns the string unchanged otherwise.
- `truncate` with `length` not larger than the suffix returns part of the suffix only.
- `isFiniteNumber('1')` is `false`, while `toFiniteNumber('1')` is `1`: the guard checks the type, the reader converts a numeric string.
- `toFiniteNumber` converts with `Number`, so `'0x1A'` gives `26` and `'1_000'` gives `undefined`.

## Best practices

- Use `memoize` for pure functions with a small, bounded key space; for anything else use a cache with eviction.
- Pass `isDefined` to `filter` instead of `(x) => x != null`; the result type then loses `null` and `undefined`.
- Read external JSON with `asPlainObject`, `asString` and `toFiniteNumber` instead of an `as` cast; a field of the wrong shape then reads as `undefined` instead of failing later.

## Examples

### Read the cost of a MySQL `EXPLAIN FORMAT=JSON` plan

MySQL prints costs as strings, so `toFiniteNumber` reads them where `isFiniteNumber` would refuse.

```ts sample
import { asPlainObject, asString, toFiniteNumber } from '@spinajs/util';

const explain: unknown = JSON.parse(
  '{"query_block":{"select_id":1,"cost_info":{"query_cost":"12.25"},"table":{"table_name":"orders","access_type":"ALL"}}}',
);

const block = asPlainObject(asPlainObject(explain)?.query_block);
const cost = toFiniteNumber(asPlainObject(block?.cost_info)?.query_cost);
const table = asString(asPlainObject(block?.table)?.table_name);

console.log(table, cost); // orders 12.25
```

## Related

- [Collections, objects and JSON](12-collections-objects-and-json.md): array, `Map` and plain-data object helpers, `sortedUnique`, `stableStringify`.
- [Assertions](03-assertions.md): guards that throw instead of returning `false`.
- [`@spinajs/di`](../di/README.md): uses `isPromise` when resolving services.
