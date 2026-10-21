# `@spinajs/http-bot`

Bot verification adapters for the [`@BotCheck`](../http/23-bot-check.md) route guard of `@spinajs/http`. It ships Google reCAPTCHA:

- `RecaptchaV3Verifier`: reCAPTCHA v3, the invisible score check. A token passes at `score >= minScore` for the check's action.
- `RecaptchaV2Verifier`: reCAPTCHA v2, the challenge captcha ("I'm not a robot" or invisible v2). It has no score or action.

Both call the legacy `siteverify` endpoint, which keeps working for keys migrated to Google Cloud projects. The free tier is 10,000 assessments a month; above that, billing must be enabled. Cloudflare Turnstile and hCaptcha adapters are planned.

It does **not** render the captcha: the page loads Google's script and sends the token. It does **not** turn a check on: see `http.bot` in [bot checks](../http/23-bot-check.md).

## Install

```sh
npm install @spinajs/http-bot
```

Import the package once (eg. `import '@spinajs/http-bot';` in the app entry) so its verifiers register in DI. It uses the global `fetch` (Node 18 or later) and adds no dependency.

## Setup

1. In the reCAPTCHA admin console, create a v3 key, and a v2 key if you want a challenge fallback. Add your domains.
2. Put the secret keys in configuration (from the environment or a secret store, never in the client).
3. Name the verifiers and turn the checks on:

```ts
export default {
  http: {
    bot: {
      enabled: true,
      verifiers: [
        { service: 'RecaptchaV3Verifier', name: 'recaptcha-v3', secret: process.env.RECAPTCHA_V3_SECRET, minScore: 0.5, expectedHostnames: ['app.example.com'] },
        { service: 'RecaptchaV2Verifier', name: 'recaptcha-v2', secret: process.env.RECAPTCHA_V2_SECRET, expectedHostnames: ['app.example.com'] },
      ],
      checks: {
        // @spinajs/authn-http ships this check with enabled: false, verifier: 'recaptcha-v3', action: 'login'.
        login: { enabled: true, fallback: 'recaptcha-v2' },
      },
    },
  },
};
```

4. On the page, get a token with the check's action and send it in `x-bot-token`:

```js
const token = await grecaptcha.execute(V3_SITE_KEY, { action: 'login' });
await fetch('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bot-token': token }, body });
```

When the answer is 400 `{ error: 'bot_check_failed', next: 'recaptcha-v2' }`, render the v2 widget and send its token with `x-bot-verifier: recaptcha-v2`.

## Options

| Option | Verifier | Default | Meaning |
| --- | --- | --- | --- |
| `service` | both | required | `RecaptchaV3Verifier` or `RecaptchaV2Verifier`. |
| `name` | both | required | The name the checks use in `verifier` and `fallback`. |
| `secret` | both | required | The secret key. An empty secret fails the boot. It is sent only in the `siteverify` form and never logged. |
| `minScore` | v3 | `0.5` | Lowest passing score, 0.0 (bot) to 1.0 (human). |
| `expectedHostnames` | both | `[]` | Hostnames the token may come from; empty accepts any. |
| `maxAgeSeconds` | both | `120` | Oldest accepted token, by its `challenge_ts`. reCAPTCHA tokens are valid for two minutes. |
| `timeoutMs` | both | `3000` | Timeout of the `siteverify` call. |
| `endpoint` | both | `https://www.google.com/recaptcha/api/siteverify` | Must be https, eg. `https://www.recaptcha.net/recaptcha/api/siteverify`. |

## Verdicts

The verifier POSTs `secret`, `response` (the token) and `remoteip` (the client address, when known) as a form. The call follows no redirect, has a timeout, and reads at most 64 KiB of a 2xx JSON answer.

| `siteverify` outcome | Verdict | Reason (logged, not sent) |
| --- | --- | --- |
| `success: true`, every check below passes | `passed` | |
| `hostname` not in `expectedHostnames` (when set) | `failed` | `hostname_mismatch` |
| `challenge_ts` older than `maxAgeSeconds`, or not a date | `failed` | `stale_token` |
| v3: `action` differs from the check's action | `failed` | `action_mismatch` |
| v3: no `score` | `failed` | `no_score` |
| v3: `score < minScore` | `failed` | `low_score` |
| `success: false` with `timeout-or-duplicate`, `invalid-input-response` or other codes | `failed` | the first error code, or `rejected` |
| `invalid-input-secret` or `missing-input-secret` | `unavailable` | `misconfigured`, logged at error level |
| Non-2xx answer, redirect, timeout, network error, non-JSON or over 64 KiB, no `success` | `unavailable` | `status`, `redirect`, `timeout`, `network`, `not_json`, `too_large`, `invalid_answer` |

v2 ignores `score` and `action`. What `unavailable` does is the check's `onUnavailable`: 503 by default.

## Services and extension points

| Service | DI token and lifetime | How to replace or extend |
| --- | --- | --- |
| `RecaptchaV3Verifier` | `@Injectable(BotVerifier)`, new instance per `http.bot.verifiers` entry | Subclass, register with `@Injectable(BotVerifier)` and `@NewInstance()`, name your class in `service`. Override `judge(answer, input)` to change the score and action rules. |
| `RecaptchaV2Verifier` | `@Injectable(BotVerifier)`, new instance per entry | As above. |
