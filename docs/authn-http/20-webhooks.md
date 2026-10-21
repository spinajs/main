# Webhooks

`WebhookAuthnEventSink` sends each authn audit event to an HTTP endpoint you configure, signed so the receiver can check where it came from. It is one more `AuthnEventSink` (see [Audit events](../authn/06-audit-events.md)): it sees every event the log sink and the database sink see.

`@spinajs/authz-http` has the same thing for authorization changes: `WebhookChangeSink`, described [below](#authorization-changes).

## How it works

1. Importing `@spinajs/authn-http` registers `WebhookAuthnEventSink` as an `AuthnEventSink`. With no `authn.webhooks` entry it does nothing.
2. For each event, it keeps the targets whose `types` list holds the event type (all targets when a target has no list).
3. It serialises the event once with `JSON.stringify` and POSTs that body to each target in parallel, with the header `Spinajs-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. The key is the target's secret.
4. A non-2xx answer, a redirect, a timeout or a network error is logged as a warn on the `authn-webhook` log and dropped. `publish` never rejects, and nothing is retried.

The body is the `AuthnEvent` as it is: `type`, `at`, `outcome` and the optional `identity`, `actor`, `strategy`, `reason`, `ip`, `userAgent`, `session` and `data`. The sink adds no field. Events never hold passwords, tokens or secrets (see [Audit events](../authn/06-audit-events.md)); the `session` field is the hashed handle, not the session id.

The sink waits for the answer, so a slow endpoint delays the call that published the event by at most `timeoutMs` (the auditor's own `authn.audit.sinkTimeoutMs` also applies). Keep `timeoutMs` low and let the receiver queue its work.

## Examples

### Send logins and MFA events to one endpoint

```js
export default {
  authn: {
    webhooks: [
      {
        url: 'https://hooks.example.com/authn',
        secret: { secret: 'aws-parameters://prod/authn/webhook-secret' },
        types: ['login', 'mfa.verify', 'password.change'],
        timeoutMs: 1500,
      },
    ],
  },
};
```

The secret is a reference the configuration resolves, like `authn.audit.hashKey.secret`; do not write the value inline.

### Check the signature in the receiver

```ts sample
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(secret: string, header: string, rawBody: string, toleranceSeconds = 300): boolean {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!match) return false;
  const t = Number(match[1]);
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return timingSafeEqual(expected, Buffer.from(match[2], 'hex'));
}
```

Hash the raw request body, not a parsed and re-serialised one.

## Authorization changes

`WebhookChangeSink` of `@spinajs/authz-http` POSTs one signed request per `ChangeBus` publish to each `authz.http.webhooks` target, with the same header and the same failure handling. The body is `{ "kind": "authz.changed", "domain": "...", "tags": [...], "at": "..." }`; `domain` is left out when the change has none. The actor is not sent.

`ChangeBus` is picked per domain when the authz service boots, so the sink does not subscribe by itself. Start it once the domain is up:

```ts sample
import { DI } from '@spinajs/di';
import { AuthzDomains, DefaultAuthzDomains } from '@spinajs/authz';
import { WebhookChangeSink } from '@spinajs/authz-http';

export async function startWebhooks(): Promise<() => void> {
  const domains = (await DI.resolve(AuthzDomains)) as DefaultAuthzDomains;
  await domains.service('root');
  const sink = await DI.resolve(WebhookChangeSink);
  return sink.start(domains.bus('root')!);
}
```

The returned function unsubscribes.

## Important behaviour

- A delivery that fails is lost. If you need every event, read the database audit stream instead.
- Redirects are not followed, so a target cannot bounce the signed body to another host.
- Logs name the target origin only; the URL path and query, which may carry a token, are never logged.
- `types: []` matches no event; leave `types` out to receive all of them.
- The `url` must be `http://` or `https://`. Use `https://` outside a private network.

## Configuration

| Key | Default | What it does |
| --- | --- | --- |
| `authn.webhooks` | `[]` | The authn targets. |
| `authn.webhooks[].url` | required | Endpoint that receives the POST. |
| `authn.webhooks[].secret.secret` | required | HMAC key, a configuration reference. |
| `authn.webhooks[].types` | all events | Event types to send. |
| `authn.webhooks[].timeoutMs` | `2000` | How long one POST may take (1 to 60000). |
| `authz.http.webhooks` | `[]` | The authz targets: `url`, `secret.secret`, `timeoutMs`, as above. |

## Related

- [Audit events](../authn/06-audit-events.md): the event shape and the other sinks.
- [`@spinajs/authz-http`](../authz-http/README.md): the package that holds `WebhookChangeSink`.
