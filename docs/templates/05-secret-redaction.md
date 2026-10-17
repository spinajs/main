# Secret redaction

`IRenderOptions.redact` lists secret values the model carries, eg. a password reset token. When the render fails, the error that reaches the perf span, the log and the caller has each value replaced by `[redacted]`. A successful render is **not** changed: the output still contains the secret, as the template intended.

## How it works

1. You call `render()`, `renderToFile()`, `compile()` or `compileToFile()` on `Templates` with `{ redact: [token, resetUrl] }`.
2. `Templates` runs the renderer inside `Perf.measure()`, and the renderer call inside `redacting()`.
3. The renderer throws, eg. a helper that quotes its argument in the error message.
4. `redactError()` builds the list of forms to strip: each non-empty value and its `encodeURIComponent()` form, deduplicated, longest first.
5. It returns a **new** `Error` whose `message` and `name` have every form replaced by `[redacted]`. The original error, its `cause` and its class are dropped.
6. The new error leaves the span: `Perf` records it on the failed `template.render` / `template.compile` metric, and the log sink prints that one.
7. The caller receives the new error.

Without `redact`, or with an empty list, the original error is rethrown unchanged.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `IRenderOptions.redact` (per call) | `readonly string[]` | not set | any strings; empty strings are ignored | Values to strip from a render error |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Error redaction | No token: a module function inside `Templates`, applied by its four render methods | raw and URI-encoded replacement | `redactError` in `@spinajs/email` uses the same rules | Not replaceable on its own. Redact in a `Templates` subclass ([Replacing the `Templates` service](08-replacing-the-templates-service.md)) or before calling it |

## Important behaviour

- Only the four `Templates` methods redact. Calling a renderer directly, eg. `getRendererFor('.pug').render(...)`, skips redaction.
- Redaction runs inside the perf span, so the failed metric never holds the secret.
- The redacted error is a plain `Error`. `instanceof IOFail` and other class checks fail on it; the original `name` is kept as a string.
- The stack trace is the redaction point's, not the renderer's. Debug with the redact list removed.
- Matching is by plain substring. Other encodings, eg. base64 or HTML entities, are **not** stripped; add those forms to the list yourself.
- `@spinajs/email-smtp-transport` passes `email.redact` here. See [Secret redaction in e-mail](../email/07-secret-redaction.md).

## Best practices

- Put both the token and every URL that embeds it in `redact`; the URI-encoded form of each is added for you.
- Keep secrets in dedicated model fields (`Token`, `ResetUrl`) so the redact list is built from the same values.

## Patterns and antipatterns

```ts
// Don't: an error that quotes the token on its own, outside the URL, keeps it
await templates.render('mail/reset.handlebars', { link }, 'en', { redact: [link] });

// Do: list the raw secret too; its URI-encoded form is added automatically
await templates.render('mail/reset.handlebars', { link }, 'en', { redact: [token, link] });
```

## Examples

### Render a password reset mail without leaking the token on failure

```ts sample
import '@spinajs/templates-handlebars';
import { randomBytes } from 'crypto';
import { DI } from '@spinajs/di';
import { Templates } from '@spinajs/templates';

async function renderResetMail(email: string) {
  const templates = await DI.resolve(Templates);
  const token = randomBytes(24).toString('base64url');
  const resetUrl = `https://app.example.com/password-reset?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;

  // a failure rejects with eg. "helper failed on [redacted]", safe to log
  return await templates.render('./views/mail/password-reset.handlebars', { email, resetUrl }, 'en', { redact: [token, resetUrl] });
}

void renderResetMail('alice@example.com');
```

## Related

- [Rendering templates](01-rendering-templates.md): the methods that take `IRenderOptions`.
- [Performance measurement](../log/15-performance-measurement.md): how a failed span reaches the log.
- [`@spinajs/email` secret redaction](../email/07-secret-redaction.md): the same rules for mail transports.
