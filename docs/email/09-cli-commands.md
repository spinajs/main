# CLI commands

The package ships two `@spinajs/cli` commands: `email-send` sends one mail from the shell, and `email-server` runs the worker that delivers [deferred mails](04-deferred-sending.md). The shipped config adds this package's `cli` folder to `system.dirs.cli`, so both are discovered without extra setup.

## How it works

### `email-server`

1. `EmailServer.execute()` resolves `EmailService` lazily (`@LazyInject()`).
2. It calls `processDeferredEmails()`, which subscribes to `EmailSend` jobs on the queue routed by `queue.routing.EmailSend`.
3. Each job is sent through the [send pipeline](01-sending-email.md#how-it-works).

```sh
spinajs email-server
```

### `email-send`

1. `SendEmailCommand.execute(options)` reads `--model` as a JSON file when the path exists.
2. It builds an `IEmail` from the options; `--to` is split on commas.
3. With `--deferred` it calls `sendDeferred()`, else `send()`.
4. Success logs `Email send succesyfully to: ...` at `success` level. A failure is logged as `Cannot send email`; the command does **not** rethrow it.

```sh
spinajs email-send -c main -f billing@acme.com -t anna@client.com,bob@client.com -s "Invoice INV-104" -ct "Your invoice is ready."
spinajs email-send -c main -f billing@acme.com -t ops@acme.com -s "Usage report" -e usage-report.pug -m ./report-model.json --deferred
```

| Option | Required | Maps to | Meaning |
| --- | --- | --- | --- |
| `-c, --connection [connection]` | yes | `connection` | Connection name. |
| `-f, --from [from]` | yes | `from` | Sender address. |
| `-t, --to [to]` | yes | `to` | Recipients, comma separated. |
| `-s, --subject [model]` | yes | `subject` | Subject. |
| `-e, --template [template]` | no | `template` | Template file in `email.templateFs`. |
| `-m, --model [model]` | no | `model` | Path to a JSON file with template data. |
| `-ct, --content [content]` | no | `text` | Plain-text body when there is no template. |
| `-df, --deferred` | no | | Queue the mail instead of sending it. |
| `-sd, --schedule-delay [delay]` | no | `schedule.delay` | Delay in milliseconds. |
| `-sc, --schedule-cron [cron]` | no | `schedule.cron` | Cron entry. |
| `-sr, --schedule-repeat [count]` | no | `schedule.repeat` | Number of repeats. |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `system.dirs.cli` | `string[]` | includes `node_modules/@spinajs/email/lib/<cjs\|mjs>/cli` and the same one folder up | | Where the CLI finds these commands. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Email service used by the commands | `EmailService`, lazy | `DefaultEmailService` | | Replace the token, see [03](03-email-service.md); both commands use the replacement. |

## Important behaviour

- **`email-send` logs the error and rethrows it**, so a failed send is not reported as success.
- **`email-send` always sets `schedule`** (with `undefined` fields when no schedule option is given).
- **`email-server` keeps running** while the queue subscription is open.

## Best practices

- Use `email-send` against a `BlackHoleEmailSender` or `redirectTo` connection to smoke-test configuration on a new stack.
- Run one `email-server` per queue consumer group, as its own process next to the HTTP app.

## Related

- [Deferred sending](04-deferred-sending.md): what `email-server` consumes.
- [`@spinajs/cli`](../cli/README.md): running commands and `system.dirs.cli`.
