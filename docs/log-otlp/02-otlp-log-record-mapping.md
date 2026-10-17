# OTLP log record mapping

Every buffered entry becomes one OTLP `LogRecord`, and every batch becomes one OTLP Logs JSON payload. This page lists what goes where, so you can query the fields in your backend and predict what a custom variable turns into.

## How it works

1. `send(batch)` calls `toOtlp(batch, Options.resource, Options.scopeName)`.
2. `toOtlp()` builds one `resourceLogs` entry with one `scopeLogs` entry, and maps each `IOtlpRecord` with `toLogRecord()`.
3. `toLogRecord()` reads `entry.Level` and `entry.Variables`:
   1. `severityNumber` comes from `LogLevelToSeverityNumber[entry.Level]`.
   2. `severityText` is the `level` variable, `body` is the `message` variable.
   3. `traceId` and `spanId` variables become top-level fields of the record.
   4. An object-valued `error` variable becomes `exception.type`, `exception.message` and `exception.stacktrace` attributes.
   5. Every other variable becomes an attribute, encoded by `anyValue()`.

Payload shape:

```json
{
  "resourceLogs": [
    {
      "resource": { "attributes": [{ "key": "service.name", "value": { "stringValue": "billing-api" } }] },
      "scopeLogs": [
        {
          "scope": { "name": "@spinajs/log" },
          "logRecords": [
            {
              "timeUnixNano": "1760700000000000000",
              "observedTimeUnixNano": "1760700000000000000",
              "severityNumber": 17,
              "severityText": "ERROR",
              "body": { "stringValue": "Charge failed" },
              "attributes": [
                { "key": "exception.type", "value": { "stringValue": "TypeError" } },
                { "key": "logger", "value": { "stringValue": "billing" } },
                { "key": "invoiceId", "value": { "intValue": "1042" } }
              ],
              "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
              "spanId": "00f067aa0ba902b7"
            }
          ]
        }
      ]
    }
  ]
}
```

## Field mapping

| `LogRecord` field | Source | Notes |
| --- | --- | --- |
| `timeUnixNano` | `IOtlpRecord.timeUnixNano` | Set in `write()` from `Date.now()` |
| `observedTimeUnixNano` | `IOtlpRecord.timeUnixNano` | Same value as `timeUnixNano` |
| `severityNumber` | `LogLevelToSeverityNumber[entry.Level]` | See the table below |
| `severityText` | `Variables.level` | Upper-case level name, for example `"ERROR"` |
| `body` | `Variables.message` | `{ stringValue: String(message ?? "") }`; the target's `layout` is not applied |
| `traceId` | `Variables.traceId` | Top-level, only when not `null`/`undefined`; converted with `String()` |
| `spanId` | `Variables.spanId` | Top-level, only when not `null`/`undefined`; converted with `String()` |
| `attributes` | all other `Variables` | In variable order; `message`, `level`, `traceId` and `spanId` are never attributes |

Severity numbers follow the OpenTelemetry bands:

| `LogLevel` | `severityNumber` | OTel band |
| --- | --- | --- |
| `Trace` | 1 | TRACE |
| `Debug` | 5 | DEBUG |
| `Info` | 9 | INFO |
| `Success` | 11 | INFO |
| `Warn` | 13 | WARN |
| `Error` | 17 | ERROR |
| `Fatal` | 21 | FATAL |
| `Security` | 23 | FATAL |

## Errors as `exception.*` attributes

The log serializers turn a logged `Error` into a plain object. When the `error` variable is a non-array object, `toLogRecord()` emits the OTel exception semantic attributes instead of the object:

| Attribute | From | Emitted when |
| --- | --- | --- |
| `exception.type` | `error.name` | `name` is defined |
| `exception.message` | `error.message` | `message` is defined |
| `exception.stacktrace` | `error.stack` | `stack` is defined |

The serialized stack already contains the `cause` chain. The `code` and `signal` fields of a serialized Node system error are **not** exported. A string-valued `error` variable is exported as a plain `error` attribute.

## Value encoding

`anyValue(v)` encodes one variable as an OTLP `AnyValue`. It never throws.

| Input | Output |
| --- | --- |
| `string` | `{ stringValue: v }` |
| `boolean` | `{ boolValue: v }` |
| integer `number` | `{ intValue: String(v) }` |
| non-integer `number` | `{ doubleValue: v }` |
| object, array, `bigint`, `null` | `{ stringValue: safeStringify(v) }`, a JSON string |
| `undefined` | `{ stringValue: undefined }`, serialized as an empty `{}` |

`kv(obj)` maps a plain object to `[{ key, value: anyValue(obj[key]) }]`, and returns `[]` for `undefined`. `toOtlp()` uses it for the resource attributes.

## API

| Export | Signature | Use |
| --- | --- | --- |
| `toOtlp` | `(batch: IOtlpRecord[], resource?: Record<string, string \| number \| boolean>, scopeName = "@spinajs/log") => Record<string, unknown>` | Full OTLP Logs payload for one batch |
| `toLogRecord` | `(record: IOtlpRecord) => Record<string, unknown>` | One `LogRecord` |
| `anyValue` | `(v: unknown) => IOtlpAnyValue` | One `AnyValue` |
| `kv` | `(obj?: Record<string, unknown>) => IOtlpKeyValue[]` | A `KeyValue` list |
| `IOtlpRecord` | `{ entry: ILogEntry; timeUnixNano: string }` | A buffered entry with its event time |

`IOtlpAnyValue` and `IOtlpKeyValue` appear in these signatures but are not exported. Use `ReturnType<typeof anyValue>` and `ReturnType<typeof kv>` when you need the types.

## Important behaviour

- **One resource, one scope per payload.** All records of a batch share the target's `resource` and `scopeName`; the logger name is an attribute (`logger`), not the scope.
- **Ambient context becomes attributes.** Scalar fields of the active `LogContext` (for example `requestId`, set per request by `@spinajs/http`) are merged into `Variables`, so they are exported as attributes on every record.
- **An empty `error` attribute on every record.** `createLogMessageObject()` always sets `error`, to `undefined` when nothing was logged. `toLogRecord()` maps it to `{ "key": "error", "value": {} }` on records that carry no error.
- **Integers are not range-checked.** `anyValue(1e21)` yields `{ intValue: "1e+21" }`, which is not a valid OTLP int64. `NaN` and `Infinity` yield `doubleValue`, which JSON serializes as `null`.
- **Nested objects are flattened to JSON strings,** not to OTLP `kvlistValue` or `arrayValue`. Query them as strings in your backend.

## Best practices

- Log structured fields with the fields overload, `log.info({ invoiceId: 1042 }, "Invoice ${invoiceId} paid")`: each field becomes its own queryable attribute.
- Pass numbers as numbers: `1042` becomes `intValue`, `"1042"` stays `stringValue`.
- Do not name a field `message`, `level`, `traceId` or `spanId` unless you mean the reserved meaning; those keys never become attributes.
- Log errors through the error overload (`log.error(err, "Charge failed")`) so the backend receives `exception.*` attributes, not a JSON blob.

## Examples

### Check what a log entry looks like on the wire

Build the payload for one entry in a unit test, without a collector.

```ts sample
import { ILogEntry, LogLevel } from '@spinajs/log';
import { IOtlpRecord, toOtlp } from '@spinajs/log-otlp';

const entry: ILogEntry = {
  Level: LogLevel.Error,
  Variables: {
    level: 'ERROR',
    logger: 'billing',
    message: 'Charge failed',
    error: undefined,
    invoiceId: 1042,
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: '00f067aa0ba902b7',
  },
};

const record: IOtlpRecord = { entry, timeUnixNano: '1760700000000000000' };
const payload = toOtlp([record], { 'service.name': 'billing-api' }, 'billing-api');

console.log(JSON.stringify(payload, null, 2));
```

## Related

- [OTLP log target](01-otlp-log-target.md): where `resource` and `scopeName` are configured.
- [Building your own OTLP exporter](06-building-your-own-otlp-exporter.md): reuse these functions in another target.
- [`@spinajs/log`](../log/README.md): `LogLevel`, `LogLevelToSeverityNumber`, serializers and `LogContext`.
