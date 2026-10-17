# Strings, functions and type guards

Small helpers for strings, deferred and cached function calls, and type guards that narrow `unknown` values.

## How it works

### Strings

| Function | Behaviour |
| --- | --- |
| `trimChar(s, char)` | Removes `char` from both ends: `trimChar('__x__', '_')` is `'x'` |
| `capitalize(s)` | Upper-cases the first character |
| `capitalizeWords(s)` | Capitalizes every whitespace-separated word, keeping the original spacing |
| `truncate(s, length, suffix = '…')` | At most `length` characters, suffix included: `truncate('the quick brown fox', 9)` is `'the quic…'` |
| `truncateWords(s, count, suffix = '…')` | At most `count` words: `truncateWords('the quick brown fox', 2)` is `'the quick…'` |
| `isNullOrWhitespace(s)` | `true` for `null`, `undefined`, `''` and whitespace only |

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

- [Collections, objects and JSON](12-collections-objects-and-json.md): array and `Map` helpers.
- [Assertions](03-assertions.md): guards that throw instead of returning `false`.
- [`@spinajs/di`](../di/README.md): uses `isPromise` when resolving services.
