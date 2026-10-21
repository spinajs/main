# MFA flow and steps

A password login can end in a pending session that needs a second factor.
This module holds the policy that decides which factors, the lookup of the
configured steps and the check of stored enrolments. The two calls that drive
the flow live on `AuthnService`.

## What it provides

- `AuthnService.authenticate(credentials, ctx)`: when the policy asks for
  steps, it returns `{ status: 'mfa_required', pending, steps }` and no
  session. `pending` is a pending session handle; `steps` are the names of
  the alternatives the caller may pass.
- `AuthnService.completeMfa(pending, step, response, ctx)`: checks one step
  (or a recovery code) and returns the same result shape as a login: a
  `success` with an `aal2` session, or a `failure`.
- `MfaStep` (`contracts/mfa.ts`): one factor. `TotpMfaStep` in
  `@spinajs/authn-totp` is the one that ships.
- `MfaPolicy` and `DefaultMfaPolicy`: which steps this login must pass.
  `MfaPolicy.steps()` gives the steps; `ConfiguredMfaPolicy` lists those of
  `authn.mfa.steps`.
- `RECOVERY_STEP`: the reserved step name for recovery codes.
- `MfaEnrolments` (also at `@spinajs/authn/mfa-enrolments`): the confirmed
  enrolments a store holds, read by the policy to refuse a login it would
  otherwise let through with the password alone.

HTTP routes are in `@spinajs/authn-http`:

| Route | Purpose |
| --- | --- |
| `POST auth/mfa/verify` | Body `{ code, step? }`. Calls `completeMfa` with `step` when it is one of the required steps, else the first one. |
| `POST auth/mfa/recovery` | Body `{ code }`. Calls `completeMfa` with `RECOVERY_STEP`. |
| `GET user/mfa` | The steps of `authn.mfa.steps` and whether the caller is enrolled. |
| `POST user/mfa`, `POST user/mfa/confirm` | Begin and confirm a TOTP enrolment; confirm returns the recovery codes once. |
| `POST user/mfa/disable` | Remove the enrolment; needs a code. |
| `POST user/mfa/recovery-codes` | New recovery codes; voids the old ones. |

`AuthnMfaController` serves the first two, `AuthnMfaEnrolmentController` the
rest.

## Steps that ship

None is on by default. `authn.mfa.steps` is unset in the default config
(under `authn.mfa`, `config/authn.ts` sets only `policy`), so
`DefaultMfaPolicy`'s `steps()` returns an empty map, the policy returns `[]` and every password
login gets an `aal1` session. A step takes part only when both hold:

1. its class is registered under `MfaStep` (`@Injectable(MfaStep)` in a
   package the app imports), and
2. the app lists it in `authn.mfa.steps`. Packages never list a step, since
   arrays concatenate across config files.

| Step | Name | Package | Notes |
| --- | --- | --- | --- |
| `TotpMfaStep` | `totp` | `@spinajs/authn-totp` (`step/totp-step.ts`) | RFC 6238 on `otpauth`. `storesSecrets = true`: seeds AES-256-GCM encrypted with a key id. Takes recovery codes (`verifyRecovery`, `regenerateRecoveryCodes`). |

TOTP is the only factor that ships. Its defaults
(`authn-totp/src/config/authn-totp.ts`): issuer `SpinaJS`, `SHA1`, 6 digits,
30 s period, `window: 1`, 10 recovery codes. To turn it on:

```ts
authn: {
  mfa: {
    steps: [{ name: 'totp', service: 'TotpMfaStep' }],
    encryptionKey: { secret: '<32 random bytes as 64 hex chars>' },
  },
}
```

and `import '@spinajs/authn-totp/db'` for the database secret store. See
`@spinajs/authn-totp`, "Turning TOTP on".

The pieces around it:

| Class | Package | Registered |
| --- | --- | --- |
| `DbMfaSecretStore` | `@spinajs/authn-totp/db` | Under `MfaSecretStore` once that entry is imported; uses `authn_mfa` and `authn_recovery_code`. |
| `MemoryMfaSecretStore` | `@spinajs/authn-totp` | Not registered. Pass it yourself, for tests or a single process; it loses every enrolment on restart. |
| `DbMfaEnrolments` | `@spinajs/authn-orm` | Under `MfaEnrolments` whenever authn-orm loads. The policy reads it to refuse a login an enrolled user would otherwise pass with the password alone. |

`FakeMfaStep` (`@spinajs/authn-testing`) is a test double, not a factor.
Email codes and passkeys are planned (`docs/auth-feat/08`, `09`) and do not
exist as steps yet.

## Registering a step

A step is a class registered under `MfaStep` and listed by service name in
`authn.mfa.steps`:

```ts
import { Injectable } from '@spinajs/di';
import { MfaStep } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';

@Injectable(MfaStep)
export class EmailCodeStep extends MfaStep {
  readonly name = 'email-code';

  async enrolled(id: IdentityRef): Promise<boolean> {
    /* does the identity have this factor? */
  }
  async beginEnrolment(id: IdentityRef): Promise<{ provisioning: string }> {
    /* shown to the owner only */
  }
  async confirmEnrolment(id: IdentityRef, response: string): Promise<{ recoveryCodes?: readonly string[] }> {
    /* recovery codes are returned once */
  }
  async verify(id: IdentityRef, response: string): Promise<boolean> {
    /* a step code only, never a recovery code */
  }
  async disable(id: IdentityRef): Promise<void> {
    /* owner and admin reset both land here */
  }
}
```

```ts
authn: {
  mfa: {
    steps: [{ name: 'email-code', service: 'EmailCodeStep' }],
  },
}
```

Rules the list is held to:

- The entry `name` must equal the step's own `name`. `recovery` is reserved
  and the schema refuses it.
- Names are unique. Arrays concatenate across config files, so a package
  never lists a step itself; the app does.
- The service is found by class name in the container and its ancestors,
  nearest first.
- A step that keeps secrets (TOTP seeds, for example) sets
  `readonly storesSecrets = true`. Outside development and test, boot then
  requires `authn.mfa.encryptionKey.secret` (32 random bytes as 64 hex
  characters, or base64 / base64url); there it only warns (A24). Rotate by
  moving the old key to `authn.mfa.encryptionKey.previous`.
- A step may add `verifyRecovery` and `regenerateRecoveryCodes` to take part
  in the recovery path.

`ConfiguredMfaPolicy`, the base of `DefaultMfaPolicy`, takes the steps through
`@AutoinjectNamedServices('authn.mfa.steps', MfaStep, …)` when the policy
resolves (at every authn boot; `authn:check-config` resolves
it too) and keeps them for the life of the instance. Login, completeMfa and the
enrolment routes all ask the policy of `authn.mfa.policy.service` for its
`steps()`, so they see that one list. A later `Configuration.set` changes
nothing until the policy and the `AuthnService` that holds it are resolved
anew. A custom policy extends `ConfiguredMfaPolicy` to get the same list, or
implements `steps()`. To list each container's own `authn.mfa.steps`, register
it per child container (`@PerChildInstance`, as `DefaultMfaPolicy` is); a
singleton lists once, from the container it is registered in.

## One step

TOTP is the usual case: the identity enrolled one step, so `steps` has one
name.

```ts
import type { AuthenticationResult, AuthnContext, AuthnService } from '@spinajs/authn';

async function loginWithOneStep(authn: AuthnService, ctx: AuthnContext, ask: (steps: readonly string[]) => Promise<string>): Promise<AuthenticationResult> {
  const first = await authn.authenticate({ kind: 'password', login: 'alice@example.test', password: '…' }, ctx);
  if (first.status !== 'mfa_required') return first;
  const [step] = first.steps;
  return authn.completeMfa(first.pending, step, await ask(first.steps), ctx);
}
```

On success the result carries the new session (`result.session`) with
`facts.assurance === 'aal2'` and `facts.mfa === [step]`. Hand the new handle
to the cookie issuer; the pending id no longer works.

## Several steps

`DefaultMfaPolicy.required` returns every step of `authn.mfa.steps` the
identity is enrolled in, in list order. They are alternatives: passing any
one of them is enough. The caller picks one, or a recovery code:

```ts
import { RECOVERY_STEP } from '@spinajs/authn';

async function loginWithAnyStep(authn: AuthnService, ctx: AuthnContext, ask: (steps: readonly string[]) => Promise<{ step: string; code: string }>): Promise<AuthenticationResult> {
  const first = await authn.authenticate({ kind: 'password', login: 'alice@example.test', password: '…' }, ctx);
  if (first.status !== 'mfa_required') return first;
  // `step` is one of first.steps, or RECOVERY_STEP with a recovery code.
  const { step, code } = await ask(first.steps);
  return authn.completeMfa(first.pending, step, code, ctx);
}
```

`completeMfa` asks the policy again, since the session does not keep the
steps it was issued with. A `step` that is not required, or that the
identity is not enrolled in, fails. With `RECOVERY_STEP` the first enrolled
step that implements `verifyRecovery` checks the code.

By default the policy returns steps for `password` logins only (see `authn.mfa.policy.methods`). A key challenge proves
possession of a key and an IdP does its own MFA, so those logins never go
pending. With `authn.mfa.policy.force`, or a role of
`authn.mfa.policy.forceForRoles`, an identity with no enrolment is required to
pass the first configured step, so its pending session can only enrol.

## A password login, step by step

### `POST auth/login` (`AuthnLoginController.login`)

1. A session the request already holds, pending ones included, is revoked.
2. `login` and `password` are read and capped at `PASSWORD_HARD_CAP`. A
   missing or over-long value answers 401 before any strategy, throttle or
   log sees it.
3. `AuthnService.authenticate({ kind: 'password', login, password }, ctx)`:
   1. `registry.candidates` picks the strategies that take passwords
      (`authn-local`). None: `unsupported_credentials`.
   2. `throttle.attempt(keys, 'login')` counts the attempt before the
      password is checked. Blocked: `throttled` with `retryAfterSeconds`.
   3. The strategy verifies. An unknown login still reads the password store
      and runs the hash, so its timing matches a known one. A stale hash is
      rehashed.
   4. The identity must be a `user` and its status must allow a login
      (`statusRefusal`).
   5. `MfaPolicy.required(id, { method, strategy })` returns the steps, or
      throws over stored enrolments (see "Stored enrolments" below).
   6. Only now `throttle.succeed(keys, 'login')`: a login the policy refuses
      keeps its count, so the backoff cannot tell a right password from a
      wrong one.
   7. No steps: an active `aal1` session, audited `login` and
      `session.issue`, result `success`. Steps: a pending session, audited
      `mfa.challenge`, result `{ status: 'mfa_required', pending, steps }`.
4. The answer: a failure is 401 with one body (plus `Retry-After` when
   throttled); `mfa_required` is 200 `{ MfaRequired: [steps] }` with the
   pending session cookie; `success` is the session cookie and the principal
   summary.

A pending session grants no route; `GET auth/` (whoami) answers only
`{ MfaRequired: [steps] }`.

### `POST auth/mfa/verify` (`AuthnService.completeMfa`)

1. The pending session is restored from the cookie. Missing or not pending:
   `not_pending`.
2. `throttle.attempt(keys, 'mfa')`, keyed by identity and address.
3. The policy is asked again, as the session does not keep its steps. The
   step must be required now and enrolled; `RECOVERY_STEP` goes to the first
   enrolled step with `verifyRecovery`. Then `step.verify(id, code)`.
4. The account status is read again; a ban or delete since the password
   revokes the pending session.
5. `SessionIssuer.elevate` raises the session to `aal2` with `mfa: [step]`
   and rotates its id. `throttle.succeed(keys, 'mfa')`.
6. Audited `mfa.verify` and `login`; the controller sets the new cookie.

Every failure along both paths reaches the client as `invalid_credentials`;
the reason goes to the audit event only.

## Verification and errors

- **Throttling.** Each `completeMfa` counts into the throttle under flow
  `'mfa'` (`authn.throttle.mfa`), keyed by identity and address, before the
  step runs. A blocked call returns `{ status: 'failure', reason:
  'throttled', retryAfterSeconds }`. A success resets the count.
- **One-time codes.** `verify` accepts a code (a TOTP time step) once, and a
  recovery code is single use. A replayed code fails.
- **Failure shape.** A wrong code, a step that is not required, a session
  that is not pending and a step that throws all return
  `invalid_credentials`; the reason (`invalid_code`, `unknown_step`,
  `not_enrolled`, `not_pending`, `step_error`, …) goes to the audit event
  `mfa.verify` only. An account banned or deleted between the two steps gets
  no session.
- **Stored enrolments.** When the identity is enrolled in no listed step, the
  policy asks every `MfaEnrolments` source (authn-orm registers one over
  `authn_mfa`). `MfaStepNotListed` means a source reports a step that
  `authn.mfa.steps` leaves out; `MfaEnrolmentMismatch` means a listed step
  does not see the enrolment a store holds. Either refuses the password
  login, with or without `force`, so a 2.x migration cannot let an enrolled
  user in with the password alone. The client sees the wrong-password
  answer. Test an error with `isMfaStepNotListed(e)` and
  `isMfaEnrolmentMismatch(e)` (matched by name, so an error of another copy
  of the module counts); both carry `e.steps`. A source that throws also
  refuses the login.
- **Boot.** A bad list fails boot: an unknown service (`ServiceNotFound`), an
  entry whose name differs from the step's name, a service that is not an
  `MfaStep`, a duplicate name, and `force` or `forceForRoles` with no step to
  require (`InvalidOption`). `forceForRoles` also needs a `RoleSource` and a
  `PrincipalFactory`. `authn:check-config` names each enrolled step the list
  lacks.
- **Session.** A success elevates the pending session to `aal2` through
  `SessionIssuer.elevate`, which rotates the id. Elevation is refused on an
  active session, so `completeMfa` cannot raise a live one.
