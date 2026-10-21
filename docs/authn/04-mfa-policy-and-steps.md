# MFA policy and steps

A password login can end in a pending session that needs a second factor. The `MfaPolicy` decides which factors a login must pass; an `MfaStep` is one factor. The core ships the policy and no step: TOTP is in [`@spinajs/authn-totp`](../authn-totp/README.md).

## How it works

1. After a verified interactive login, `DefaultAuthnService` calls `MfaPolicy.required(identity, { method, strategy })`.
2. An empty list means no second factor: the session is issued at `aal1`.
3. A non-empty list means a pending session and `{ status: 'mfa_required', pending, steps }`. The steps are alternatives.
4. `AuthnService.completeMfa(pending, step, response, ctx)` asks the policy again, checks one step or a recovery code, and elevates the session to `aal2`. See [Authentication flow](01-authentication-flow.md#second-factor-completemfa).

### What `DefaultMfaPolicy.required` returns

1. A login whose `method` is not in `authn.mfa.policy.methods` gets `[]`. The default list is `['password']`, so key, token and OIDC logins are exempt: a key challenge proves possession of a key and an identity provider does its own MFA.
2. The steps of `authn.mfa.steps` the identity is enrolled in (`MfaStep.enrolled`), in list order. When there is at least one, that list is the answer.
3. Enrolled in no listed step: every `MfaEnrolments` source of the container lineage is asked for the identity's confirmed steps.
   - A confirmed step that `authn.mfa.steps` does not list throws `MfaStepNotListed`.
   - A confirmed step that is listed, but whose step says it is not enrolled, throws `MfaEnrolmentMismatch`.
   - A source that throws fails the login too.
   The login is refused with the wrong-password answer, with or without `force`, so a user with a stored second factor never logs in with the password alone.
4. No step configured: `[]`.
5. `authn.mfa.policy.force`, or a role from `authn.mfa.policy.forceForRoles`, requires the first configured step. The pending session can then only enrol. The roles come from `PrincipalFactory` and `RoleSource.rolesOf`; when they cannot be read, the step is required.

`isMfaStepNotListed(e)`, `isMfaEnrolmentMismatch(e)` and `mfaEnrolmentRefusal(e)` recognise both errors by name, so an error of another copy of the module counts too. Both carry `e.steps`. The audit reasons are `mfa_step_not_listed` and `mfa_enrolment_mismatch`.

## The `MfaStep` contract

| Member | Meaning |
| --- | --- |
| `name` | The name in `authn.mfa.steps` and in `AuthnFacts.mfa`. `recovery` is reserved |
| `storesSecrets` | `true` when the step keeps secrets; boot then requires `authn.mfa.encryptionKey.secret` outside development and test. Default `false` |
| `enrolled(id)` | Whether the identity has this factor |
| `beginEnrolment(id)` | Returns `{ provisioning }`, shown to the owner only |
| `confirmEnrolment(id, response)` | Confirms; may return recovery codes once |
| `verify(id, response)` | Checks a step code, never a recovery code. A code is accepted once |
| `verifyRecovery?(id, code)` | Checks a single-use recovery code |
| `regenerateRecoveryCodes?(id)` | New codes, the old ones void |
| `disable(id)` | Removes the factor; the owner path and the admin reset both land here |

The caller checks fresh authentication before `beginEnrolment`, `regenerateRecoveryCodes` and `disable`. The HTTP routes for enrolment are in [`@spinajs/authn-http`](../authn-http/README.md).

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.mfa.policy.service` | `string` | `'DefaultMfaPolicy'` | A registered `MfaPolicy` class name | The policy `AuthnService` uses |
| `authn.mfa.policy.methods` | `string[]` | `['password']` | Login methods such as `password`, `oidc`, `jws`, `token` | The logins that must pass a step. Add `oidc` to ask for a step after an identity provider login, and to refuse an existing `aal1` OIDC session on `MfaSatisfied` routes |
| `authn.mfa.policy.force` | `boolean` | `false` | | Every login of a listed method of an identity with no enrolment must pass the first step |
| `authn.mfa.policy.forceForRoles` | `string[]` | `[]` | Role names | Like `force`, for identities that hold one of these roles |
| `authn.mfa.steps` | `{ name, service }[]` | `[]` | Unique names; `recovery` refused | The steps that run, in list order |
| `authn.mfa.encryptionKey.secret` | `string \| null` | unset | 32 bytes as 64 hex characters, base64 or base64url | AES-256-GCM key for stored MFA secrets. Set it from a secret reference, never inline |
| `authn.mfa.encryptionKey.previous` | `string[]` | unset | Same format | Older keys, so rows written under them still decrypt |
| `authn.mfa.totp.*` | object | see owner | | Read by [`@spinajs/authn-totp`](../authn-totp/README.md) |

```ts
authn: {
  mfa: {
    policy: { service: 'DefaultMfaPolicy', force: false, forceForRoles: ['admin'], methods: ['password', 'oidc'] },
    steps: [{ name: 'totp', service: 'TotpMfaStep' }],
    encryptionKey: { secret: '<32 random bytes as 64 hex characters, from a secret reference>' },
  },
}
```

The schema refuses `force` or a non-empty `forceForRoles` without a step to require. Boot fails when `forceForRoles` is set and no `RoleSource` or `PrincipalFactory` is registered.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `MfaPolicy` | `MfaPolicy`, named by `authn.mfa.policy.service`; `DefaultMfaPolicy` per child container | `DefaultMfaPolicy` | Your policy | Register with `@Injectable(MfaPolicy)` and name it in `authn.mfa.policy.service`; extend `ConfiguredMfaPolicy` to get the listed steps |
| `MfaStep` | `MfaStep`, listed by name in `authn.mfa.steps` | None listed | `TotpMfaStep` ([`@spinajs/authn-totp`](../authn-totp/README.md)) | `@Injectable(MfaStep)` on your class, then list it |
| `MfaEnrolments` | `MfaEnrolments`, every registration of the lineage (`Array.chainOf`) | None | `DbMfaEnrolments` ([`@spinajs/authn-orm`](../authn-orm/README.md)) | `@Injectable(MfaEnrolments)`; implement `stepsOf(id)` and `stepNames()` |

`ConfiguredMfaPolicy` lists the steps of `authn.mfa.steps` when the policy resolves, by class name in the container and its ancestors, nearest first. It keeps that list for the life of the instance. Boot fails on an unknown service (`ServiceNotFound`), an entry name that differs from the step's `name`, and a service that is not an `MfaStep`.

Login, `completeMfa` and the enrolment routes all take the steps from `MfaPolicy.steps()`, so they see one list.

### MfaStep: custom implementation

Add a factor the shipped steps do not cover, such as a code sent by SMS. Register it, then list it in `authn.mfa.steps`.

```ts sample
import { Autoinject, Injectable } from '@spinajs/di';
import { MfaStep } from '@spinajs/authn';
import type { IdentityRef } from '@spinajs/authn';

export abstract class SmsCodes {
  abstract phoneOf(id: IdentityRef): Promise<string | null>;
  abstract send(id: IdentityRef): Promise<void>;
  abstract consume(id: IdentityRef, code: string): Promise<boolean>;
  abstract register(id: IdentityRef, phone: string): Promise<void>;
  abstract confirm(id: IdentityRef, code: string): Promise<boolean>;
  abstract remove(id: IdentityRef): Promise<void>;
}

@Injectable(MfaStep)
export class SmsCodeStep extends MfaStep {
  readonly name = 'sms';

  @Autoinject(SmsCodes)
  protected Codes: SmsCodes;

  async enrolled(id: IdentityRef): Promise<boolean> {
    return (await this.Codes.phoneOf(id)) !== null;
  }

  async beginEnrolment(id: IdentityRef): Promise<{ provisioning: string }> {
    await this.Codes.send(id);
    return { provisioning: 'sms-sent' };
  }

  async confirmEnrolment(id: IdentityRef, response: string): Promise<{ recoveryCodes?: readonly string[] }> {
    if (!(await this.Codes.confirm(id, response))) throw new Error('invalid enrolment code');
    return {};
  }

  // `consume` must accept a code once, so a replayed code fails.
  async verify(id: IdentityRef, response: string): Promise<boolean> {
    return this.Codes.consume(id, response);
  }

  async disable(id: IdentityRef): Promise<void> {
    await this.Codes.remove(id);
  }
}
```

```ts
authn: {
  mfa: {
    steps: [
      { name: 'totp', service: 'TotpMfaStep' },
      { name: 'sms', service: 'SmsCodeStep' },
    ],
  },
}
```

## Important behaviour

- Steps run only for logins whose `method` is in `authn.mfa.policy.methods` (default `password`). An OIDC login of an identity enrolled in TOTP gets a session at `aal1` and `MfaSatisfied` passes it; list `oidc` to change that.
- The required steps are alternatives: passing any one elevates the session to `aal2`.
- A recovery code enters as `completeMfa(pending, 'recovery', code, ctx)` (`RECOVERY_STEP`). The first enrolled step that implements `verifyRecovery` checks it.
- Under `force` the required step may be one the identity has not enrolled. `completeMfa` refuses it (`not_enrolled`): the pending session can only enrol.
- A policy that throws refuses the login, and the throttle keeps the count.
- Each `completeMfa` call counts into the `mfa` throttle flow before the step runs.
- A later `Configuration.set` changes the step list only once the policy and the `AuthnService` that holds it are resolved anew.
- `authn:check-config` names every enrolled step the list lacks. It cannot see a mismatch.

## Best practices

- Turn a step on in the app's own config file: list it and set `authn.mfa.encryptionKey.secret` when it stores secrets.
- Keep a step listed while users are enrolled in it. Removing it refuses their password logins.
- Rotate the encryption key by moving the old one to `authn.mfa.encryptionKey.previous`.
- A policy that changes the steps per container must be per child container, as `DefaultMfaPolicy` is. A singleton lists the steps once.

## Examples

### Complete a login with any enrolled factor or a recovery code

```ts sample
import { RECOVERY_STEP } from '@spinajs/authn';
import type { AuthenticationResult, AuthnContext, AuthnService } from '@spinajs/authn';

export async function loginWithAnyStep(authn: AuthnService, ctx: AuthnContext, login: string, password: string, ask: (steps: readonly string[]) => Promise<{ step: string; code: string }>): Promise<AuthenticationResult> {
  const first = await authn.authenticate({ kind: 'password', login, password }, ctx);
  if (first.status !== 'mfa_required') return first;
  const { step, code } = await ask([...first.steps, RECOVERY_STEP]);
  return authn.completeMfa(first.pending, step, code, { ...ctx, session: first.pending });
}
```

On success `result.session` is the new `aal2` session with `facts.mfa` set to `[step]`. The pending id no longer works.

## Related

- [Authentication flow](01-authentication-flow.md): where the policy is called.
- [`@spinajs/authn-totp`](../authn-totp/README.md): the TOTP step and its `authn.mfa.totp.*` keys.
- [`@spinajs/authn-orm`](../authn-orm/README.md): MFA storage and `DbMfaEnrolments`.
- [`@spinajs/authn-http`](../authn-http/README.md): the MFA and enrolment routes.
