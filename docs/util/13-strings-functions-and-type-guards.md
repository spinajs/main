# Strings, functions and type guards

Small helpers for strings, dates, deferred, cached and maybe-async function calls, and type guards that narrow `unknown` values.

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
- `once` marks itself called before running `fn`. When `fn` throws, later calls return `undefined` instead of retrying.
- `memoize` never evicts entries, and it caches a rejected promise like any other result.
- `Lazy.call` runs the callback every time; it does not cache. Combine it with `once` for a lazily computed value.
- `truncateWords` joins the kept words with single spaces when it truncates; it returns the string unchanged otherwise.
- `truncate` with `length` not larger than the suffix returns part of the suffix only.

## Best practices

- Use `memoize` for pure functions with a small, bounded key space; for anything else use a cache with eviction.
- Pass `isDefined` to `filter` instead of `(x) => x != null`; the result type then loses `null` and `undefined`.

## Related

- [Collections, objects and JSON](12-collections-objects-and-json.md): array, `Map` and plain-data object helpers, `sortedUnique`, `stableStringify`.
- [Assertions](03-assertions.md): guards that throw instead of returning `false`.
- [`@spinajs/di`](../di/README.md): uses `isPromise` when resolving services.
