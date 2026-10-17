# Log entries and message templates

`createLogMessageObject()` turns the arguments of a log call into an `ILogEntry`: a level plus a flat bag of variables that targets render. `renderTemplate()` and `renderValue()` render the `${field}` message template of a structured call with escaping, so a field value cannot forge a field or a line.

## How it works

`createLogMessageObject(err, message, level, logger, variables, ...args)`:

1. **Pick the message.**
   - `err` is an `Error`: the message is `message`, or `err.message` when `message` is `null` or `undefined`.
   - `err` is falsy: the message is `message`.
   - `err` is a non-empty string: `err` itself is the message.
2. **Format.** With `args`, the message runs through a built-in `util.format` clone: `%s %d %i %f %j %o %O %%`. Arguments left over are appended, space-separated; objects render as JSON. Without `args` the message is kept as it is.
3. **Read the ambient context.** The function registered with [`setLogContextProvider()`](04-ambient-log-context.md) is called; a throw or `null` counts as `{}`.
4. **Merge the variables**, later wins:
   1. ambient context fields;
   2. `error` (the `Error`, or `undefined`), `level` (upper-case name), `logger` (`logger ?? message`), `message` (the formatted text);
   3. `variables` (logger variables and per-call fields).
5. **Serialize.** `applySerializers()` runs the [field serializers](05-serializers.md). By default `error` becomes `{ name, message, stack, code?, signal? }`.
6. **Return** `{ Level: level, Variables }`.

### Call forms in `FrameworkLogger`

| Call | Becomes |
| --- | --- |
| `log.info('User %s signed in', id)` | `createLogMessageObject('User %s signed in', null, level, name, vars, id)` |
| `log.error(err, 'Payment %s failed', id)` | `createLogMessageObject(err, 'Payment %s failed', level, name, vars, id)` |
| `log.error(err)` | `message` is `err.message` |
| `log.info({ userId }, 'User ${userId} signed in')` | `renderTemplate()` on the message with the call's fields, then `createLogMessageObject(null, text, level, name, { ...vars, ...fields }, ...args)` |

## API

| Export | Signature | Meaning |
| --- | --- | --- |
| `createLogMessageObject` | `(err: Error \| string, message: string \| any[], level: LogLevel, logger: string, variables: any, ...args: any[]) => ILogEntry` | Builds an entry as above. |
| `renderTemplate` | `(template: string, fields: Record<string, unknown>, escapePercent = false) => string` | Renders `${name}` and `${?name}...${/name}` against `fields` only. |
| `renderValue` | `(v: unknown) => string` | Renders one field value for a log line. |
| `ILogEntry` | `{ Level: LogLevel; Variables: LogVariables }` | What a target receives. |
| `LogVariables` | `ILogStaticVariables & ILogVariable` | `error`, `level`, `logger`, `message` plus any `[key: string]: unknown`. |
| `ILogStaticVariables` | `{ error: Error \| undefined; level: string; logger: string; message: string }` | The core fields. |
| `ILogVariable` | `{ [key: string]: unknown \| (() => unknown) }` | Extra fields. |

### `renderTemplate()` rules

- `${name}`: the field rendered with `renderValue()`. A field that is absent, `null`, `undefined` or `''` renders as nothing.
- `${?name}...${/name}`: the body is kept only when the field is set (same test).
- Only the call's `fields` are read. Ambient context and logger variables do not fill a `${name}`.
- `${name:option}` is left as it is, for the target layout to render.
- `escapePercent = true` doubles `%` in rendered values, so printf args formatted afterwards do not consume them. `FrameworkLogger` sets it when the call has args.
- A template without `${` is returned unchanged.

### `renderValue()` rules

| Value | Output |
| --- | --- |
| Valid `Date` | ISO string |
| `Error` | Its `message`, rendered as a string |
| Object whose JSON is a string (eg. a luxon `DateTime`) | That string, rendered as a string |
| Other object or array | JSON, escaped |
| Function | `""` (an empty quoted string) |
| String of letters, digits and `_ . , : ; / \ + @ # ~ * ! ? & \| ( ) [ ] < > ' -` | As it is |
| Any other string | JSON-quoted and escaped |

Escaping turns `$`, U+007F to U+009F, Unicode line and paragraph separators, bidi marks and the BOM into `\uXXXX`. A value therefore cannot add a line, flip text direction or inject a `${...}` placeholder into the layout.

## Layout variables

Targets render `Variables` through their `layout` with `format()` from [`@spinajs/configuration-common`](../configuration-common/01-templating.md). Every key of `Variables` is available as `${key}`; built-in variables such as `${datetime}` come from that package.

| Variable | Value |
| --- | --- |
| `${level}` | Upper-case level name, eg. `INFO` |
| `${message}` | The formatted message |
| `${logger}` | The logger name |
| `${error}` | The serialized error record; use `${error:message}` for its message |
| `${datetime}` | Rendered by `@spinajs/configuration-common`, not stored on the entry |
| Any logger variable, call field or ambient field | As stored |

The default layout of every `LogTarget` is:

```
${datetime} ${level} ${message}${?error} Exception: ${error:message}${/error} (${logger})
```

## Important behaviour

- `Variables.error` holds the serialized record, not the `Error`, although `ILogStaticVariables` types it as `Error | undefined`. Read `error.message` and `error.stack` from the record; `instanceof Error` is `false`.
- Per-call fields and logger variables override the core fields. A field named `message`, `level` or `logger` replaces the computed one.
- When `logger` is `null` or `undefined`, `Variables.logger` is the `message` argument.
- `format()` from `@spinajs/configuration-common` also expands `${...}` inside `message`. Text passed through `%s` is not escaped; a value containing `${level}` is expanded by the layout. Values passed as fields go through `renderValue()` and are escaped.
- `createLogMessageObject()` does not check `level`. A number missing from `LogLevelStrings` throws a `TypeError`.

## Best practices

- Pass untrusted values (user names, URLs, headers) as fields with a `${field}` template, not as `%s` args.
- Keep the template constant and the data in fields: targets such as `JsonTarget` keep the fields as separate keys.
- Use `${?field}...${/field}` for optional parts instead of building the message with string concatenation.

## Patterns and antipatterns

```ts
// Don't: a user-controlled value is formatted into the message unescaped.
log.warn('Login failed for %s', req.body.login);

// Do: the value is escaped by renderValue() and kept as a separate field.
log.warn({ login: req.body.login }, 'Login failed for ${login}');
```

## Examples

### Render a structured audit line

```ts sample
import { renderTemplate } from '@spinajs/log-common';

const line = renderTemplate('Role ${role} granted to ${user}${?by} by ${by}${/by}', {
  role: 'admin',
  user: 'jane doe',
  by: null,
});

console.log(line); // Role admin granted to "jane doe"
```

### Build an entry with an error and extra fields

```ts sample
import { createLogMessageObject, ISerializedError, LogLevel } from '@spinajs/log-common';

const cause = new Error('ECONNRESET');
const entry = createLogMessageObject(new Error('Payment failed', { cause }), 'Charge %s failed', LogLevel.Error, 'billing', { orderId: 'ORD-9' }, 'ch_1');

const error = entry.Variables.error as unknown as ISerializedError;
console.log(entry.Variables.message); // Charge ch_1 failed
console.log(entry.Variables.orderId); // ORD-9
console.log(error.message); // Payment failed
console.log(error.stack?.includes('Caused by: Error: ECONNRESET')); // true
```

## Related

- [Ambient log context](04-ambient-log-context.md): fields merged at the lowest precedence.
- [Serializers](05-serializers.md): what happens to `error` and other fields after the merge.
- [Log targets](06-log-targets.md): where `layout` is configured.
- [`@spinajs/configuration-common` templating](../configuration-common/01-templating.md): the layout syntax.
