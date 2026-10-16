# Authn feature plans

Eleven implementation plans that close the gaps found when we compared the v3 authn stack with Ory Kratos (2026-10-06). Each plan is self-contained and follows the `superpowers:writing-plans` format: TDD steps, exact paths, one commit per task.

The plans assume the v3 stack of branch `authz-v3-refactor`: `@spinajs/authn` contracts, `DefaultAuthnService`, the opt-in 3.0 HTTP layer (`registerAuthnHttpV3()`), and `authn-orm` stores.

## Plans

| # | Plan | Tasks | Packages | Depends on | Rule |
|---|---|---|---|---|---|
| 01 | [Strict environment by default](01-env-strict-default.md) | 7 | configuration, configuration-common, authn, authn-http, authn-oidc, authz, authz-http, http, http-socket, email | none | none |
| 02 | [Breached-password and similarity checks](02-password-breach-and-similarity.md) | 7 | authn, authn-local, users | none | A33 |
| 03 | [Stable numeric message IDs](03-message-ids.md) | 5 | authn, authn-http, authn-oidc | none | A34 |
| 04 | [CSRF synchronizer token](04-csrf-synchronizer-token.md) | 6 | authn, authn-http | 03 | A35 |
| 05 | [CAPTCHA](05-captcha.md) | 9 | authn, authn-http, new authn-captcha | 03 | A36 |
| 06 | [Email and phone verification](06-email-phone-verification.md) | 12 | authn, authn-orm, users, email, authn-http, authn-oidc | 03, 05 | A37 |
| 07 | [Self-service registration](07-self-service-registration.md) | 7 | authn, authn-local, users, authn-http | 02, 03, 05, 06 | A38 |
| 08 | [Passwordless email code](08-passwordless-email-code.md) | 8 | authn, authn-http | 03, 05, 06 | A39 |
| 09 | [WebAuthn and passkeys](09-webauthn-passkeys.md) | 16 | new authn-webauthn, authn-orm, authn-http | 03 | A40 |
| 10 | [Outbound webhooks](10-outbound-webhooks.md) | 6 | new authn-webhooks | a durable queue broker (AMQP, STOMP or SQS) | none |
| 11 | [Password hash import](11-password-hash-import.md) | 8 | authn, authn-local, users, users-http | none | A41 |

Suggested order: 01 and 02 first because they are the cheap security wins. Then 03, which every plan with a user-facing answer builds on. After that, 04, 05, 09, 10 and 11 can run in parallel. 06 must land before 07 and 08.

**Behaviour rule IDs.** The plans were written in parallel, so several of them name their `authn-testing` rule A33. The **Rule** column above is authoritative. When a plan's text names another ID, rename the rule in every place that plan lists (`RULE_IDS`, the spec file name, `define…`, the docs row). Tests that pin the full `RULE_IDS` list must include every rule that has already landed.

## Corrections found while writing the plans

These override the original brief, and the plans already follow them.

- **authn already treats an unset env as production** (SR-16, `packages/authn/src/service/boot/env.ts`). The gap that plan 01 closes is in the other packages: `configuration.isProduction` is false when no env is named, and that affects the authz explain route and traces, HTTP error detail, and email redirection. The 2.x secret checks read only `NODE_ENV`.
- **There are no 3.0 password routes.** Reset, change and invite are still served only by the 2.x controllers. Plan 05 guards the 2.x `PasswordResetController` reset request, because N8c does not replace that controller. Plan 03 reserves IDs for the password outcomes, but nothing emits them yet.
- **A02 pins the body of every login failure, throttled ones included.** The `retryAfterSeconds` context cannot appear on login, MFA or reauth answers. `Retry-After` stays the only signal there.
- **The CAPTCHA gate runs in the 3.0 HTTP layer, not in `DefaultAuthnService`.** It uses the helper `captchaRefusal(container, req, flow, account?)` in `packages/authn-http/src/v3/captcha.ts`. `AuthnContext` gets no `captcha` field. Plans 06, 07 and 08 call this helper.
- **The strategy contract is `AuthenticationStrategy`**, not `AuthnStrategy`. `ThrottleFlow` is a closed union: 06 adds `verify`, 07 adds `register`, 08 adds `code`.
- **`DefaultMfaPolicy` asks for MFA only after a `password` login** (`default-mfa-policy.ts:55`). Plan 08 changes it so that a code login does not skip enrolled TOTP.
- **`MfaStep` gains `challenge?` and `sameFactorAs?`** (plan 08) for steps that must send something before verification. WebAuthn returns assertion options from `challenge`, so the shared signature is `challenge?(id: IdentityRef): Promise<Readonly<Record<string, unknown>> | void>`. Whichever of 08 and 09 lands second keeps the wider form.
- **Verified addresses live in a `users_address` table** (plan 06), not in columns on `users`. A row records that one exact value was verified.
- **The code HMAC helpers live on the subpath `@spinajs/authn/codes`.** The `contracts` entry may import only `@spinajs/di`.
- **Registration has a core `RegistrationService` contract** (plan 07), implemented by `LocalRegistrationService` in authn-local, because only authn-local can hash.
- **Webhooks need a real broker.** The ORM queue transport is commented out, and the default connection is a black hole. Plan 10 fails the boot when endpoints are configured without a durable connection.
- **Stale docs.** `docs/authn/README.md` still lists as TODO the middleware, `IdentityStore`, `ImpersonationGuard`, `RoleSource`, the throttle default, the ORM, queue and fs adapters, the authz-http-admin routes and `QueueAuthnEventSink`. All of these exist.

## Shared contracts

Several plans touch the same seams. The names below are fixed here so that plans written and executed separately agree. The plan named as **owner** creates the contract, and the other plans consume it unchanged.

### One-time codes (owner: 06; consumers: 07, 08)

`packages/authn/src/contracts/codes.ts`, exported from `@spinajs/authn/contracts`:

```ts
import type { IdentityRef } from './credentials.js';

export type CodePurpose = 'verify' | 'login' | 'register' | (string & {});

export interface IssuedCode {
  /** Digits only; shown to the user once. */
  readonly code: string;
  readonly ttlSeconds: number;
}

export type CodeCheck = 'ok' | 'invalid' | 'expired' | 'exhausted';

/**
 * Short numeric codes, stored as HMAC-SHA256 under `authn.codes.secret` (a six-digit code hashed with plain SHA-256 is
 * reversed offline in milliseconds). A subject has at most one live code per purpose; issue replaces it.
 * After `authn.codes.maxAttempts` (default 5) wrong answers the code is void ('exhausted').
 */
export abstract class OneTimeCodeStore {
  /** `subject` is `identityKey(ref)`, or `address:<channel>:<normalized value>` before an identity exists. */
  abstract issue(subject: string, purpose: CodePurpose, opts: { readonly ttlSeconds: number; readonly length?: number }): Promise<IssuedCode>;
  abstract verify(subject: string, purpose: CodePurpose, code: string): Promise<CodeCheck>;
}

export interface CodeMessage {
  readonly channel: 'email' | 'sms';
  readonly to: string;
  readonly purpose: CodePurpose;
  readonly code: string;
  /** A link that carries the code, when the flow offers one. */
  readonly link?: string;
  readonly ttlSeconds: number;
  readonly locale?: string;
  readonly identity?: IdentityRef;
}

/** Renders and sends at once; never queues, persists or logs `code` or `link` (same rule as PasswordMailer, SR-09). */
export abstract class CodeSender {
  abstract send(message: CodeMessage): Promise<void>;
}
```

Implementations:
- `MemoryOneTimeCodeStore` in `packages/authn/src/codes/` is for tests.
- `DbOneTimeCodeStore` in `packages/authn-orm/src/codes/` uses table `authn_code`.
- `EmailCodeSender` in `packages/email/src/` sits next to `password-mailer.ts`.
- No SMS transport ships. An app registers its own `CodeSender` that handles `channel: 'sms'`.

### Verifiable addresses (owner: 06; consumers: 07, 08)

These go in `packages/authn/src/contracts/identity.ts`, and `@spinajs/users` implements them:

```ts
export type AddressChannel = 'email' | 'sms';

export interface VerifiableAddress {
  readonly channel: AddressChannel;
  /** Normalized: email lower-cased; phone E.164. */
  readonly value: string;
  readonly verifiedAt: Date | null;
}

export abstract class AddressStore {
  abstract addresses(id: IdentityRef): Promise<readonly VerifiableAddress[]>;
  abstract findByAddress(channel: AddressChannel, value: string): Promise<IdentityRef | null>;
  /** False when `value` is no longer an address of `id` (changed since the code was sent). */
  abstract markVerified(id: IdentityRef, channel: AddressChannel, value: string, at: Date): Promise<boolean>;
}
```

### Identity creation (owner: 07)

These go in `packages/authn/src/contracts/identity.ts`, and `@spinajs/users` implements them:

```ts
export interface RegistrationInput {
  readonly email: string;
  readonly login?: string;
  readonly name?: string;
  /** Already hashed by the password strategy; absent for passwordless sign-up. */
  readonly passwordHash?: string;
  readonly locale?: string;
}

export type RegistrationOutcome = { readonly created: true; readonly identity: IdentityRef } | { readonly created: false; readonly existing: IdentityRef };

export abstract class IdentityRegistrar {
  abstract register(input: RegistrationInput): Promise<RegistrationOutcome>;
}
```

### CAPTCHA (owner: 05; consumers: 07, 08)

`packages/authn/src/contracts/captcha.ts`:

```ts
export type CaptchaFlow = 'login' | 'register' | 'reset' | 'code' | 'verify';

export abstract class CaptchaGate {
  /** Whether this request must carry a solved challenge (config per flow: 'off' | 'always' | 'adaptive'). */
  abstract required(flow: CaptchaFlow, ctx: { readonly ip?: string; readonly account?: string }): Promise<boolean>;
  /** Verifies the client token with the provider; false on a wrong, reused or expired token. */
  abstract verify(flow: CaptchaFlow, token: string | undefined, ctx: { readonly ip?: string }): Promise<boolean>;
}
```

If no `CaptchaGate` is registered, CAPTCHA is off. Consumers resolve it as optional.

### Message IDs (owner: 03; consumers: 04 to 09)

Plan 03 defines the `AuthnMessage` shape and the catalogue in `packages/authn/src/messages/`. Each consumer plan adds its entries in its own range, so plans never collide:

| Range | Owner |
|---|---|
| 1000000–1000999 / 4000000–4000999 | 03: existing answers (login, MFA, session, reset, impersonation, role switch) |
| 4001000–4001999 | 02: password policy violations (03 numbers them, 02 adds its kinds) |
| 4002000–4002999 | 04: CSRF |
| 1003000–1003999 / 4003000–4003999 | 05: CAPTCHA |
| 1004000–1004999 / 4004000–4004999 | 06: verification |
| 1005000–1005999 / 4005000–4005999 | 07: registration |
| 1006000–1006999 / 4006000–4006999 | 08: code login |
| 1007000–1007999 / 4007000–4007999 | 09: WebAuthn and passkeys |

The leading `1` means info and the leading `4` means a user error, as in Kratos. IDs are stable: once released, an ID is never reused with a different meaning.

### Audit event types

Each plan adds its own members to `AuthnEventType` (`packages/authn/src/contracts/audit.ts`). If two plans add members at the same time, they only need a trivial merge.

| Plan | New members |
|---|---|
| 04 | `csrf.reject` |
| 05 | `captcha.fail` |
| 06 | `verification.request`, `verification.verify` |
| 07 | `registration` |
| 08 | `code.request` (a successful code login is a `login` with `strategy: 'code'`) |
| 09 | `webauthn.register`, `webauthn.remove` (use is `mfa.verify` or `login`) |
| 11 | `password.import` |

## Conventions every plan follows

The same as `.superpowers/sdd/global-constraints.md`:
- English comments, identifiers and commits. Comment only what the code cannot say.
- One commit per task.
- Run tests from the package directory with `npx ts-mocha -p tsconfig.json <file>`. Run `npm test` for a full suite.
- After changing a package, rebuild it (`npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`) before testing the packages that depend on it.
- Keep CRLF line endings.
- Value checks and defaults go in the module's JSON schema (`@Config` plus the AJV schema). Code keeps only DI lookups, compilation and cross-domain merges.
- Secrets are secret references, never inline values.
- Each new behaviour rule gets a row in `packages/authn-testing`, continuing the A-series. The last existing rule is A32, and each plan takes the next free numbers when it lands.
- HTTP work targets the 3.0 layer (`packages/authn-http/src/v3`), never the 2.x controllers.
