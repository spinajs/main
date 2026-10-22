# Bot checks

`@BotCheck(name)` guards a route with a bot verification provider: a captcha or a score service. The client sends the provider's token in a request header; the route middleware hands it to a `BotVerifier` before the route arguments are extracted, so a refused request never reaches validation or the action.

This package holds the provider-free part: the `BotVerifier` port, `BotCheckMiddleware`, `@BotCheck`, the `BotCheckFailed` exception and its answer, and the `http.bot` configuration. Provider adapters live in other packages; [`@spinajs/http-bot`](../http-bot/README.md) ships Google reCAPTCHA v3 and v2.

Every check is off by default. A check runs only when **both** `http.bot.enabled` and `http.bot.checks.<name>.enabled` are true; otherwise the middleware passes the request on and no verifier is built.

## How it works

On a request to a route marked `@BotCheck('login')`:

1. Policies run first, then the controller's middlewares, then the route's. Decorators apply bottom-up, so the middleware decorator nearest the method runs first: put `@BotCheck` above the other middleware decorators of the route so it runs last.
2. The check is off (master switch or the check's own switch): the request goes on.
3. The token is read from `http.bot.header` (default `x-bot-token`). Missing, empty or longer than 2048 characters (`BOT_TOKEN_MAX_LENGTH`): `BotCheckFailed(check, 'missing')`.
4. The verifier is the check's `verifier`. When the client names another one in `http.bot.verifierHeader` (default `x-bot-verifier`), it must be the check's `fallback`; any other name is `failed` without calling a verifier.
5. The verifier gets `{ token, action, ip, hostname }`. `action` is the check's `action`, else its name; `ip` is `req.storage.realIp` (see [client IP](17-client-ip-and-trust-proxy.md)), else `req.ip`.
6. The verdict decides:
   - `passed`: the route arguments are extracted and the action runs.
   - `failed`: `BotCheckFailed(check, 'failed', next)`. `next` is the check's `fallback`, only when the check's own verifier failed the token.
   - `unavailable` (the provider is down, over quota, misconfigured, or the verifier threw): with `onUnavailable: 'refuse'` (default), `BotCheckFailed(check, 'unavailable')`; with `'allow'`, the request goes on and a warning is logged at most once a minute per check.

The verifier's own reason (eg. `low_score`) is logged at debug level and never sent to the client.

## Answers

| Case | Status | Body | Headers |
| --- | --- | --- | --- |
| No token, or one over the cap | 400 | `{ "error": "bot_check_failed", "reason": "missing" }` | `Cache-Control: no-store` |
| Token failed, check with a fallback | 400 | `{ "error": "bot_check_failed", "reason": "failed", "next": "<fallback>" }` | `Cache-Control: no-store` |
| Token failed, no fallback (or the fallback failed it) | 400 | `{ "error": "bot_check_failed", "reason": "failed" }` | `Cache-Control: no-store` |
| Verifier unavailable, `onUnavailable: 'refuse'` | 503 | `{ "error": "bot_check_unavailable" }` | `Cache-Control: no-store`, `Retry-After: 30` |

`BotCheckFailedResponse` builds these bodies itself (`@HandleException(BotCheckFailed)`), so no message or stack reaches the client. The same answers apply on a login route: a bot refusal is not the uniform login failure, so the client knows to show a captcha.

## Usage

```ts
import { BaseController, BasePath, BotCheck, Ok, Post } from '@spinajs/http';

@BasePath('newsletter')
export class NewsletterController extends BaseController {
  @Post('subscribe')
  @BotCheck('newsletter')
  public async subscribe() {
    return new Ok();
  }
}
```

`@BotCheck` on the class guards every route of the controller.

A client using reCAPTCHA v3 with a v2 fallback:

```js
async function subscribe(body) {
  const token = await grecaptcha.execute(V3_SITE_KEY, { action: 'newsletter' });
  let res = await post('/newsletter/subscribe', body, { 'x-bot-token': token });
  const answer = res.status === 400 ? await res.json() : null;
  if (answer?.error === 'bot_check_failed' && answer.next === 'recaptcha-v2') {
    const challenge = await showV2Captcha(); // the v2 widget's response token
    res = await post('/newsletter/subscribe', body, { 'x-bot-token': challenge, 'x-bot-verifier': 'recaptcha-v2' });
  }
  return res;
}
```

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.bot.enabled` | `boolean` | `false` | | Master switch. |
| `http.bot.header` | `string` | `x-bot-token` | non-empty | Request header carrying the token. |
| `http.bot.verifierHeader` | `string` | `x-bot-verifier` | non-empty | Request header naming the verifier the token is for. |
| `http.bot.verifiers` | `{ service, name, ... }[]` | `[]` | | Verifier services by name. `service` is the registered class name, `name` the key the checks use; the rest is the adapter's options. |
| `http.bot.checks.<name>.enabled` | `boolean` | `false` | | Turns the check on. |
| `http.bot.checks.<name>.verifier` | `string` | required | a `verifiers[].name` | The verifier of the check. |
| `http.bot.checks.<name>.action` | `string` | the check name | non-empty | Expected action, for providers that bind a token to one (reCAPTCHA v3). |
| `http.bot.checks.<name>.onUnavailable` | `string` | `refuse` | `refuse`, `allow` | What an unavailable verifier does: 503, or let the request through with a warning. |
| `http.bot.checks.<name>.fallback` | `string` | none | a `verifiers[].name` | The verifier the client is told to show after a failed token, and may then name in `verifierHeader`. |

```ts
export default {
  http: {
    bot: {
      enabled: true,
      verifiers: [
        { service: 'RecaptchaV3Verifier', name: 'recaptcha-v3', secret: process.env.RECAPTCHA_V3_SECRET, minScore: 0.5 },
        { service: 'RecaptchaV2Verifier', name: 'recaptcha-v2', secret: process.env.RECAPTCHA_V2_SECRET },
      ],
      checks: {
        newsletter: { enabled: true, verifier: 'recaptcha-v3', fallback: 'recaptcha-v2', onUnavailable: 'refuse' },
      },
    },
  },
};
```

At startup, when the master switch and at least one check are on, `BotCheckService` builds the verifiers and checks the `verifier` and `fallback` of every enabled check. An unknown name throws `InvalidOption` naming the key (eg. `http.bot.checks.newsletter.verifier`), and the routes are not built.

## Services and extension points

| Service | DI token and lifetime | Default implementation | How to replace or extend |
| --- | --- | --- | --- |
| `BotVerifier` (abstract) | Class `BotVerifier`; one instance per `http.bot.verifiers` entry, by `@AutoinjectService('http.bot.verifiers', BotVerifier)` | none here; `RecaptchaV3Verifier`, `RecaptchaV2Verifier` in `@spinajs/http-bot` | Extend it, register with `@Injectable(BotVerifier)` (and `@NewInstance()` so two entries of one class get their own options), name the class in `service`. |
| `BotVerifierRegistry` | Singleton | | Holds `Verifiers: Map<name, BotVerifier>`; resolved only when a check is on. |
| `BotCheckService` | Singleton `AsyncService` | | Runs a check: `check(name, req)`, `checkFor(name)`. Subclass and register as `BotCheckService` to change the flow. |
| `BotCheckMiddleware` | `RouteMiddleware`, new instance per route | | Attached by `@BotCheck(name)`; the constructor takes the check name. |
| `BotCheckFailedResponse` | Error map entry for `BotCheckFailed` | | Register your own response with `@HandleException(BotCheckFailed)` to change the answers. |

A verifier:

```ts
import { Injectable, NewInstance } from '@spinajs/di';
import { BotVerifier } from '@spinajs/http';
import type { BotCheckInput, BotVerdict, IBotVerifierOptions } from '@spinajs/http';

@Injectable(BotVerifier)
@NewInstance()
export class InternalScoreVerifier extends BotVerifier {
  constructor(protected readonly options: IBotVerifierOptions & { url: string }) {
    super(options);
  }

  public async verify(input: BotCheckInput): Promise<BotVerdict> {
    // Network errors and timeouts must become { result: 'unavailable' }; a thrown error counts as unavailable too.
    return { result: 'passed' };
  }
}
```

Members:

- `BotVerifier.Name`: the config entry's `name`; `ServiceName` returns it, which keys the map.
- `BotVerdict`: `{ result: 'passed', score? }`, `{ result: 'failed', reason, score? }` or `{ result: 'unavailable', reason }`.
- `BotCheckFailed(check, reason, next?)`: `reason` is `'missing'`, `'failed'` or `'unavailable'`.
- `BOT_TOKEN_MAX_LENGTH` (2048), `BOT_UNAVAILABLE_RETRY_AFTER_SECONDS` (30), `BOT_CONFIGURATION_SCHEMA`.
