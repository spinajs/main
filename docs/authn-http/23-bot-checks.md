# Bot checks on the anonymous routes

Five anonymous routes carry a [`@BotCheck`](../http/23-bot-check.md) of `@spinajs/http`. The package ships every check with `enabled: false`, and `http.bot.enabled` is off by default, so nothing changes until you turn a check on and configure a verifier (eg. reCAPTCHA from [`@spinajs/http-bot`](../http-bot/README.md)).

| Route | Check | Shipped `action` |
| --- | --- | --- |
| `POST /auth/login` | `login` | `login` |
| `POST /auth/register` | `register` | `register` |
| `POST /auth/password/reset-request` | `password_reset` | `password_reset` |
| `POST /auth/code/request` | `code_request` | `code_request` |
| `POST /auth/passkeys/challenge` | `passkey_challenge` | `passkey_challenge` |

`passkey_challenge` also guards the challenge a pending (pre-MFA) session asks for there.

Each check ships as `{ enabled: false, verifier: 'recaptcha-v3', action: <the action above>, onUnavailable: 'refuse' }`. Name your score verifier `recaptcha-v3`, or set `verifier` per check. reCAPTCHA v3 actions allow only letters, digits, `/` and `_`, so the client must call `grecaptcha.execute(key, { action })` with the same value.

## What a refused request does

The check runs after the policies and before the route reads its body. A refused request:

- answers 400 `{ error: 'bot_check_failed', reason, next? }` with `Cache-Control: no-store`, or 503 `{ error: 'bot_check_unavailable' }` with `Retry-After: 30` when the provider is down and the check refuses then (the default);
- makes no throttle attempt, so it costs the account and the IP nothing;
- reaches no strategy and writes no audit event: a refused login is not a failed login.

On `POST /auth/login` this answer differs from the uniform 401 of a failed login on purpose: the client must learn to show a captcha. It says nothing about the account. Once the check passes, every failure is the uniform 401 as before.

## Turning login on

```ts
export default {
  http: {
    bot: {
      enabled: true,
      verifiers: [
        { service: 'RecaptchaV3Verifier', name: 'recaptcha-v3', secret: process.env.RECAPTCHA_V3_SECRET },
        { service: 'RecaptchaV2Verifier', name: 'recaptcha-v2', secret: process.env.RECAPTCHA_V2_SECRET },
      ],
      checks: {
        login: { enabled: true, fallback: 'recaptcha-v2' },
      },
    },
  },
};
```

The page sends the token in `x-bot-token`:

```js
const token = await grecaptcha.execute(V3_SITE_KEY, { action: 'login' });
await fetch('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bot-token': token }, body: JSON.stringify({ login, password }) });
```

The CORS configuration must allow the `x-bot-token` (and `x-bot-verifier`) request headers for a cross-origin client: add them to `http.cors.allowedHeaders`.
