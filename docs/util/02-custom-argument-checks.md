# Custom argument checks

A check is a plain function `(arg, name) => any`. Any function with that signature plugs into `_check_arg`, `_try_check_arg`, `_or`, `_is_array_of` and the nested checks of every `_is_*` guard. Write one when the built-in checks do not cover a rule, or to bundle a chain you repeat.

## How it works

1. `_check_arg` calls your check with the current value and the field name.
2. Return the value to pass it on unchanged, or return a new value to transform it.
3. Throw `InvalidArgument(message, name, errorCode)` to fail. `_try_check_arg` turns only `InvalidArgument` into `[false, error]`; any other error escapes it.
4. A check factory (a function that returns a check) lets the check take parameters, as `_min(5)` does.

There are three levels of reuse, from least to most code:

| Level | Use when | Example |
| --- | --- | --- |
| `_custom(predicate, error?)` | A yes/no rule with the default `CUSTOM_VALIDATION_FAILED` code, or a fixed error | `_custom((v: string) => v !== 'admin')` |
| `_convert(fn, error?)` | A transform whose `throw` means "invalid" | `_convert((v: string) => new URL(v))` |
| Your own check factory | A rule with its own error code, message or parameters | `_is_iban()`, `_not_before(date)` |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Check function `(arg: any, name: string) => any` | Not registered in DI; passed by value | The built-in `_*` checks | `_custom`, `_convert`, your own factory | Return a function with the check signature; compose it anywhere a check is accepted |
| Type guard with nested checks | Not registered in DI | `_is_string`, `_is_number`, `_is_array`, ... | Your own guard | Test the type, then return `_check_arg(...checks)(arg, name)` |

### Custom check: a parameterized rule with its own error code

Follow the shape of the built-in checks: a factory that takes the parameters and an optional `InvalidArgument`, and returns the check. Pass non-matching types through when the rule only makes sense for one type, so the check composes after `_or` or `_default`.

```ts sample
import { InvalidArgument } from '@spinajs/exceptions';
import { _check_arg, _is_string, _to_date, _trim } from '@spinajs/util';
import { DateTime } from 'luxon';

/** Fails a DateTime earlier than `limit`; other values pass through. */
export function _not_before(limit: DateTime, error?: InvalidArgument) {
  return function (arg: unknown, name: string) {
    if (!(arg instanceof DateTime)) {
      return arg;
    }
    if (arg.toMillis() < limit.toMillis()) {
      throw error ?? new InvalidArgument(`${name} should not be before ${limit.toISODate()}`, name, 'DATE_TOO_EARLY');
    }
    return arg;
  };
}

const deliveryDate = _check_arg(_is_string(), _trim(), _to_date('yyyy-MM-dd'), _not_before(DateTime.now().startOf('day')));

const d: DateTime = deliveryDate('2099-01-31', 'deliveryDate');
console.log(d.toISODate());
```

### Custom type guard with nested checks

A guard tests the type, then runs the nested checks on the narrowed value, exactly like `_is_string`.

```ts sample
import { InvalidArgument } from '@spinajs/exceptions';
import { _check_arg, _is_array_of, _is_string, _custom } from '@spinajs/util';

export function _is_url(...checks: ((arg: URL, name: string) => unknown)[]) {
  return function (arg: unknown, name: string): URL {
    let url: URL;
    try {
      url = arg instanceof URL ? arg : new URL(String(arg));
    } catch {
      throw new InvalidArgument(`${name} should be an absolute URL`, name, 'TYPE_MISMATCH');
    }
    return _check_arg(...checks)(url, name);
  };
}

const httpsOnly = _custom((u: URL) => u.protocol === 'https:', new InvalidArgument('webhooks must use https', 'webhooks', 'INSECURE_URL'));

const webhooks = _check_arg(_is_array_of(_is_string(), _is_url(httpsOnly)));

const urls: URL[] = webhooks(['https://hooks.example.com/a', 'https://hooks.example.com/b'], 'webhooks');
console.log(urls.map((u) => u.host));
```

## Important behaviour

- `_or` catches every error a branch throws, including a `TypeError` from your check. Throw `InvalidArgument` deliberately and keep the check free of accidental crashes.
- `_is_array_of` wraps your element error in a new `InvalidArgument` with code `ARRAY_ELEMENT_VALIDATION_FAILED`, `fieldName` set to the array name, and your error as `inner`.
- The value you return is what later checks see. A check that returns nothing turns the value into `undefined`.

## Best practices

- Name a factory `_verb_noun` or `_is_thing`, like the built-ins, so a chain reads as one vocabulary.
- Give each custom rule its own `errorCode`; callers map codes to messages and HTTP fields.
- Bundle a chain you repeat into one check: `const _username = () => _check_arg(_is_string(), _trim(), _to_lower(), _between(3, 32));` is itself a check.

## Patterns and antipatterns

```ts
// Don't: returning a boolean replaces the value with true or false
const _even = () => (arg: number) => arg % 2 === 0;

// Do: throw on failure, return the value on success
const _even = () => (arg: number, name: string) => {
  if (arg % 2 !== 0) throw new InvalidArgument(`${name} should be even`, name, 'NOT_EVEN');
  return arg;
};
```

## Related

- [Argument validation](01-argument-validation.md): the built-in checks and `_check_arg`.
- [`@spinajs/exceptions`](../exceptions/README.md): `InvalidArgument`.
