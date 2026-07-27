# Argument validation (`args`)

A small, composable validation DSL. You build a validator by **combining checks**, then run it against a value. Checks both **validate** (throwing `InvalidArgument` on failure) and **transform** (coercing/normalizing the value that flows to the next check).

```ts
import { _check_arg, _is_string, _trim, _non_empty, _max_length } from '@spinajs/util';
```

## The core: `_check_arg`

`_check_arg(...checks)` returns a function `(value, name) => validatedValue`. Checks run left-to-right; each receives the (possibly transformed) output of the previous one:

```ts
const validate = _check_arg(_is_string(), _trim(), _non_empty(), _max_length(32));

validate('  hello  ', 'username'); // -> 'hello'   (trimmed)
validate('', 'username');          // throws InvalidArgument: "username should not be empty"
validate(42, 'username');          // throws InvalidArgument: "username should be string"
```

The `name` is used in error messages. `InvalidArgument` carries `fieldName` and `errorCode` (e.g. `TYPE_MISMATCH`, `EMPTY_VALUE`, `RANGE_ERROR`) for programmatic handling.

## Non-throwing variant: `_try_check_arg`

Returns a `[ok, valueOrError]` tuple instead of throwing — handy for graceful handling:

```ts
const [ok, result] = _try_check_arg(_is_number(), _min(0))(input, 'age');
if (!ok) {
  // result is the InvalidArgument
  return res.badRequest(result.message);
}
// result is the validated number
```

## Type guards

Each asserts the type, then runs nested checks on the value:

```ts
_is_string(...checks)
_is_number(...checks)
_is_boolean(...checks)   // also accepts 0/1
_is_array(...checks)     // checks run against the array
_is_array_of(...checks)  // checks run against *each element*, errors report the index
_is_object(...checks)    // plain object (not array/null)
_is_map(...checks)
_is_instance_of(Ctor, ...checks)
_contains_key(key)       // Map has key / object has property
```

```ts
// validate every element of an array
_check_arg(_is_array_of(_is_string(), _non_empty()))(['a', 'b'], 'tags');
_check_arg(_is_array_of(_is_number()))(['x'], 'nums'); // throws: "nums[0] validation failed: ..."
```

## Presence & nullability

```ts
_non_null()       // rejects null
_non_undefined()  // rejects undefined
_non_NaN()        // rejects NaN
_non_empty()      // rejects '' / []
_non_nil()        // rejects null/undefined/''/[]/{}  (the broadest)
_default(value)   // substitutes value (or value() factory) when nil/empty
```

```ts
_check_arg(_default('anonymous'))('', 'name');       // -> 'anonymous'
_check_arg(_default(() => Date.now()))(null, 'ts');  // -> lazy default
```

## Ranges & comparison (numbers, string/array length)

```ts
_between(min, max)     // number value, OR string/array length, within [min, max]
_min_length(n)         // string/array length >= n
_max_length(n)         // string/array length <= n
_min(v) / _max(v)      // numeric bounds (inclusive)
_lt(v) / _lte(v)       // numeric < / <=  (pass through non-numbers)
_gt(v) / _gte(v)       // numeric > / >=  (pass through non-numbers)
_positive()            // number > 0
```

## Choice & pattern

```ts
_contains(['a', 'b', 'c'])     // value must be one of the array
_one_of(['a', 'b'])            // alias for _contains
_reg_match(/^\d+$/)            // string matches regex (passes through non-strings)
_glob_match('*.ts')           // string matches a glob
_is_email()                   // string is an email
_is_uuid()                    // string is a v4 uuid
_custom((v) => v.isValid)     // arbitrary predicate
```

## Transforms & conversions

Transforms change the value flowing downstream:

```ts
_to_upper() / _to_lower()      // string case (no-op on non-strings)
_trim(char?)                   // trim whitespace, or a specific char
_to_int() / _to_float()        // parse string -> number
_to_date(fromFormat?)          // parse string/Date -> luxon DateTime (start of day)
_convert((v) => transform(v))  // arbitrary mapping, wraps thrown errors
```

```ts
const port = _check_arg(_is_string(), _to_int(), _between(1, 65535))(process.env.PORT!, 'PORT');
const day  = _check_arg(_to_date('yyyy-MM-dd'))('2026-07-13', 'date'); // DateTime
```

## Combinator: `_or`

Passes if **any** branch passes:

```ts
const idOrEmail = _or(_is_uuid(), _is_email());
_check_arg(idOrEmail)('a@b.com', 'user'); // ok
_check_arg(idOrEmail)('nope', 'user');    // throws: "should pass at least one check"
```

## Custom error messages

Every validating check accepts an optional `InvalidArgument` to override the default:

```ts
import { InvalidArgument } from '@spinajs/exceptions';

_check_arg(_min(18, new InvalidArgument('Must be an adult', 'age', 'TOO_YOUNG')))(15, 'age');
```

## Putting it together

```ts
function createUser(input: unknown) {
  const email = _check_arg(_is_string(), _trim(), _to_lower(), _is_email())(input, 'email');
  // email is a validated, normalized string here
}
```
