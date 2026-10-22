# `@spinajs/authn-webauthn`

WebAuthn for SpinaJS, on [`@simplewebauthn/server`](https://simplewebauthn.dev): passkey login (`PasskeyStrategy`), a WebAuthn second factor (`WebAuthnMfaStep`) and the owner's passkey management (`WebAuthnPasskeyService`, behind the `PasskeyService` contract of `@spinajs/authn`).

It does **not** ship HTTP routes: [`@spinajs/authn-http`](../authn-http/README.md) serves `/auth/passkeys/*` and `/user/passkeys` through `AuthnPasskeyController`. It keeps public keys only, never a secret, so it needs no `authn.mfa.encryptionKey`.

## Install

```sh
npm install @spinajs/authn-webauthn @spinajs/authn @spinajs/authn-orm @spinajs/orm
```

## Features

| Feature | What it does |
| --- | --- |
| [Setup and configuration](01-setup.md) | What the package registers, the `authn.webauthn.*` keys, and how to turn passkeys and the second factor on |
| [Passkey login](02-passkey-login.md) | `PasskeyStrategy`: the login ceremony, assurance (aal2 with user verification, aal1 without), replay and clone protection |
| [Passkey management](03-passkey-management.md) | `WebAuthnPasskeyService`: registration options, registration, list and removal; the routes and their answers |
| [Second factor](04-second-factor.md) | `WebAuthnMfaStep` (`webauthn`): enrolment, verification, recovery codes |
| [Stores](05-stores.md) | `WebAuthnCredentialStore`, `WebAuthnChallengeStore`, `WebAuthnRecoveryCodeStore`; the memory and ORM implementations and the migration |
| [Action hooks](06-action-hooks.md) | The `authn.passkey.register` and `authn.passkey.revoke` actions: refuse or observe a passkey registration or removal with an `ActionHook` |

## Quick start

```ts
// app.ts
import '@spinajs/authn-webauthn';
import '@spinajs/authn-webauthn/db';
```

```js
// config
authn: {
  strategies: [{ name: 'passkey', service: 'PasskeyStrategy' }],
  webauthn: { rpId: 'example.com', rpName: 'Example', origins: ['https://example.com'] },
}
```

The browser then runs two ceremonies: `POST /user/passkeys/options` and `POST /user/passkeys` to register a passkey from a fresh session, and `POST /auth/passkeys/challenge` and `POST /auth/passkeys/login` to log in with it.
