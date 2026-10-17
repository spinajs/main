# Argument validation

`_check_arg` builds a validator from a list of checks and runs it on one value. Each check either validates (throws `InvalidArgument`) or transforms the value passed to the next check. Use it at a boundary: constructor options, environment variables, request input.

## How it works

1. `_check_arg(...checks)` returns a function `(arg, name) => any`. Nothing runs yet.
2. Calling it runs the checks left to right. Each check is `(arg, name) => any`; its return value becomes `arg` for the next check.
3. A failing check throws `InvalidArgument` from `@spinajs/exceptions`, with `fieldName` set to `name` and an `errorCode` (table below). The remaining checks do not run.
4. The validator returns the value the last check returned.

Type checks (`_is_string`, `_is_number`, ...) take nested checks: they test the type first, then run their own `_check_arg(...checks)` on the value.

`_try_check_arg(...checks)` runs the same chain but returns a tuple: `[true, value]` on success, `[false, error]` when an `InvalidArgument` was thrown. Any other error is rethrown. `name` is optional there and defaults to `'argument'`.

## Checks

### Type checks

| Check | Passes when | Error code | Notes |
| --- | --- | --- | --- |
| `_is_string(...checks)` | `typeof arg === 'string'` | `TYPE_MISMATCH` | |
| `_is_number(...checks)` | `typeof arg === 'number'` | `TYPE_MISMATCH` | `NaN` passes; add `_non_NaN()` |
| `_is_boolean(...checks)` | a boolean, or the numbers `0` and `1` | `TYPE_MISMATCH` | `0` and `1` are **not** converted to booleans |
| `_is_array(...checks)` | `Array.isArray(arg)` | `TYPE_MISMATCH` | Nested checks receive the whole array |
| `_is_array_of(...checks)` | an array whose every element passes `checks` | `TYPE_MISMATCH`, `ARRAY_ELEMENT_VALIDATION_FAILED` | Elements are validated as `name[index]`; returns the mapped array; the element error is the `inner` |
| `_is_object(...checks)` | a non-null object that is not an array | `TYPE_MISMATCH` | Class instances pass |
| `_is_map(...checks)` | `arg instanceof Map` | `TYPE_MISMATCH` | |
| `_is_instance_of(Ctor, ...checks)` | an object whose `constructor.name` equals `Ctor.name` | `TYPE_MISMATCH` | Compares names, not prototypes: a subclass fails |
| `_contains_key(key)` | a `Map` with `key`, or an object with own key `String(key)` | `MISSING_KEY` | Any other type passes |

### Presence and defaults

| Check | Rejects | Error code |
| --- | --- | --- |
| `_non_null(error?)` | `null` | `NULL_VALUE` |
| `_non_undefined(error?)` | `undefined` | `UNDEFINED_VALUE` |
| `_non_NaN(error?)` | anything global `isNaN()` is true for, such as `NaN`, `'abc'`, `undefined` | `NAN_VALUE` |
| `_non_empty(error?)` | a string or array of length 0 | `EMPTY_VALUE` |
| `_non_nil(error?)` | `null`, `undefined`, `''`, `[]`, an object with no own keys | `EMPTY_VALUE` |
| `_default(value)` | nothing: replaces `null`, `undefined`, `''`, `[]` or `{}` with `value`, or with `value()` when it is a function | |

### Ranges and comparisons

| Check | Passes when | Error code | Other types |
| --- | --- | --- | --- |
| `_between(min, max, error?)` | a number in `[min, max]`, or a string or array whose length is in `[min, max]` | `RANGE_ERROR` | Pass |
| `_min_length(n, error?)` | string or array length `>= n` | `LENGTH_TOO_SHORT` | Throw `TYPE_MISMATCH` |
| `_max_length(n, error?)` | string or array length `<= n` | `LENGTH_TOO_LONG` | Throw `TYPE_MISMATCH` |
| `_min(v, error?)` / `_max(v, error?)` | `arg >= v` / `arg <= v` | `VALUE_TOO_SMALL` / `VALUE_TOO_LARGE` | Compared with `<` and `>` as they are |
| `_lt(v)` / `_lte(v)` | `arg < v` / `arg <= v` | `VALUE_TOO_LARGE` | Pass |
| `_gt(v)` / `_gte(v)` | `arg > v` / `arg >= v` | `VALUE_TOO_SMALL` | Pass |
| `_positive(error?)` | a number `> 0` | `NEGATIVE_OR_ZERO` | Throw |
| `_finite(error?)` | `Number.isFinite(arg)` | `NOT_FINITE` | Throw |
| `_integer(error?)` | `Number.isInteger(arg)` | `NOT_INTEGER` | Throw |

### Choice and pattern

| Check | Passes when | Error code | Non-strings |
| --- | --- | --- | --- |
| `_contains(values, error?)` / `_one_of(values, error?)` | `values.includes(arg)` | `INVALID_CHOICE`; `TYPE_MISMATCH` when `values` is not an array | |
| `_reg_match(regex, error?)` | `regex.test(arg)` | `PATTERN_MISMATCH` | Pass |
| `_glob_match(glob, error?)` | the string matches the glob (converted by `glob-to-regexp`) | `PATTERN_MISMATCH` | Pass |
| `_is_email()` | `^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$` | `PATTERN_MISMATCH` | Pass |
| `_is_uuid()` | a lower-case version 4 UUID | `PATTERN_MISMATCH` | Pass |
| `_custom(predicate, error?)` | `predicate(arg)` is truthy | `CUSTOM_VALIDATION_FAILED` | |
| `_or(...checks)` | any check passes; returns that check's result | `VALIDATION_FAILED` | |

### Transforms and conversions

| Check | Returns | Error code |
| --- | --- | --- |
| `_trim(char?)` | the string trimmed of whitespace, or of `char` at both ends | none; non-strings pass |
| `_to_upper()` / `_to_lower()` | the string in upper or lower case | none; non-strings pass |
| `_to_int(error?)` | `parseInt(arg)` | `PARSE_ERROR` when the result is `NaN` |
| `_to_float(error?)` | `parseFloat(arg)` | `PARSE_ERROR` when the result is `NaN` |
| `_to_date(fromFormat?, error?)` | a Luxon `DateTime` at the start of the day, from a `Date`, an ISO string, or a string in `fromFormat` | `PARSE_ERROR` |
| `_convert(fn, error?)` | `fn(arg)` | `CONVERSION_FAILED` when `fn` throws |

Every check that takes `error?` throws that `InvalidArgument` instead of its default one.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| A check, `(arg, name) => any` | Not registered in DI; a plain function passed to `_check_arg` | The checks above | Your own functions | Write a function with the check signature; see [Custom argument checks](02-custom-argument-checks.md) |

## Important behaviour

- `_check_arg` returns `any`. Annotate the variable you assign it to.
- Checks that only validate strings or numbers (`_reg_match`, `_lt`, `_trim`, ...) let other types through. Put a type check first.
- `_to_int` uses `parseInt`: `'12abc'` becomes `12`. Add `_reg_match(/^\d+$/)` before it when trailing characters must fail.
- `_or` swallows every branch error. Its message lists the check function names, which are empty for the built-in checks, so the message ends in a list of commas.
- `_is_uuid` accepts lower-case version 4 UUIDs only. Put `_to_lower()` before it to accept upper case.
- `_to_date` drops the time of day. Without `fromFormat`, its error message says `in format undefined`.
- `_non_empty` reads `arg.length`: on `null` or `undefined` it throws a `TypeError`, not `InvalidArgument`. Use `_non_nil` for values that may be missing.
- A custom `error` instance is created once, when the chain is built, and thrown on every failure.

## Best practices

- Build a validator once at module level and reuse it; `_check_arg(...)` allocates the closure on every call.
- Normalize before you compare: `_trim()`, `_to_lower()`, then `_is_email()` or `_contains()`.
- Check `errorCode` on the caught `InvalidArgument` to map validation failures to field errors, rather than parsing `message`.

## Patterns and antipatterns

```ts
// Don't: _to_int runs before any type check, and '8080abc' parses as 8080
const port = _check_arg(_to_int(), _between(1, 65535))(process.env.PORT, 'PORT');

// Do
const port: number = _check_arg(_is_string(), _reg_match(/^\d+$/), _to_int(), _between(1, 65535))(process.env.PORT, 'PORT');
```

## Examples

### Validate a sign-up payload and report field errors

```ts sample
import { InvalidArgument } from '@spinajs/exceptions';
import { _check_arg, _is_array_of, _is_email, _is_string, _max_length, _min_length, _one_of, _to_lower, _trim, _try_check_arg } from '@spinajs/util';

const email = _check_arg(_is_string(), _trim(), _to_lower(), _is_email());
const displayName = _check_arg(_is_string(), _trim(), _min_length(2), _max_length(40));
const roles = _check_arg(_is_array_of(_is_string(), _to_lower(), _one_of(['reader', 'editor'])));

function parseSignUp(input: Record<string, unknown>) {
  try {
    return {
      email: email(input.email, 'email') as string,
      displayName: displayName(input.displayName, 'displayName') as string,
      roles: roles(input.roles ?? ['reader'], 'roles') as string[],
    };
  } catch (err) {
    if (err instanceof InvalidArgument) {
      return { field: err.fieldName, code: err.errorCode, message: err.message };
    }
    throw err;
  }
}

console.log(parseSignUp({ email: '  Ann@Example.com ', displayName: 'Ann', roles: ['EDITOR'] }));
console.log(parseSignUp({ email: 'ann@example.com', displayName: 'A' }));
// { field: 'displayName', code: 'LENGTH_TOO_SHORT', ... }

const [ok, age] = _try_check_arg(_is_string(), _trim())('  42 ', 'age');
console.log(ok, age); // true '42'
```

### Parse query parameters with defaults

```ts sample
import { _between, _check_arg, _default, _is_number, _non_NaN, _or, _to_date, _to_int } from '@spinajs/util';

const page = _check_arg(_default('1'), _to_int(), _between(1, 10_000));
const pageSize = _check_arg(_or(_is_number(_non_NaN()), _to_int()), _between(1, 100));
const since = _check_arg(_default(() => new Date(Date.now() - 7 * 86_400_000)), _to_date());

const query: Record<string, string | undefined> = { pageSize: '25' };

console.log(page(query.page, 'page'), pageSize(query.pageSize, 'pageSize'), since(query.since, 'since').toISODate());
```

## Related

- [Custom argument checks](02-custom-argument-checks.md): write your own checks for `_check_arg`.
- [Assertions](03-assertions.md): imperative guards that narrow a type inside a function body.
- [`@spinajs/exceptions`](../exceptions/README.md): `InvalidArgument` and its `fieldName` and `errorCode`.
