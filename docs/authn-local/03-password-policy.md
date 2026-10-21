# Password policy

`LocalPasswordPolicy` decides whether a new password is acceptable, describes the policy for clients, and generates random passwords. `LocalPasswordService` applies it wherever a password is set: change, set and reset. A login never runs it.

## How it works

**Check** (`check(password, ctx?)`, also `PasswordService.check()`). `ctx` is a `PasswordPolicyContext` (`{ login?, email?, name? }`, from `@spinajs/authn`): the identifiers of the account the password is for.

1. Above 1024 code points (`PASSWORD_HARD_CAP`, from `@spinajs/authn/contracts`, re-exported by this package), it answers `['too_long']` at once, without the rule or the blocklist.
2. It counts code points (`codePointLength()`): an emoji counts as one. Below `minLength` adds `too_short`, above `maxLength` adds `too_long`.
3. When `authn.local.policy.rule` is set, the password string is validated against that JSON schema with Ajv. A mismatch adds `rule`.
4. With a `ctx` and `authn.local.policy.similarity` on (the default), the identifier rule runs. It lower-cases the login, the email, the name, and the local part of each that is an address, and skips any shorter than 3 characters. A password that contains one of them (ignoring case), or is within 2 edits (Levenshtein, in code points) of one, adds `similar_to_identifier`. Without `ctx` the rule is skipped.
5. When a [blocklist](04-password-blocklist.md) is configured, `PasswordBlocklist.isBlocked(password, ctx)` runs. `true` adds `blocklisted`.
6. It answers every violation together, in that order. An empty array means acceptable.

`LocalPasswordService` builds the context itself: change and set pass what `IdentityStore.display()` shows for the identity (`email`, `name`); reset and invite redeem resolve the login first and pass the typed login plus what the store shows for an eligible account. `@spinajs/users` passes the new login and email when it checks a password before it creates an account.

**Public policy** (`policy()`, also `PasswordService.policy()`) answers `{ minLength, maxLength, pattern?, description? }`. `pattern` is the rule's top-level `pattern` string, when it has one. A blank `description` is left out. `GET /auth/password/policy` in [`@spinajs/authn-http`](../authn-http/12-password-routes.md) serves it.

**Generate** (`generate()`):

1. It joins `authn.local.generator.characters` into one pool; a repeated code point counts once.
2. When `generator.length` is outside the policy bounds, it throws `UnexpectedServerError`.
3. It draws `length` code points uniformly with `crypto.randomInt` and keeps the first draw that passes the length bounds and the rule, in up to 10 attempts. It does **not** check the blocklist.
4. When no draw passes, it throws `UnexpectedServerError`: the pool and the rule disagree.

**Boot.** `resolve()` checks the bounds, compiles the rule and finds the blocklist class. `LocalPasswordStrategy` injects the policy, so a bad `authn.local.policy` fails the boot of every app that lists the `local` strategy. These errors are `InvalidOption`:

- `minLength` is not an integer of at least 8;
- the rule does not compile;
- `blocklist` names a class not registered as a `PasswordBlocklist`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.local.policy.minLength` | `integer` | `8` | `8` to `128` | Shortest new password, in code points. |
| `authn.local.policy.maxLength` | `integer` | `128` | `minLength` to `128` | Longest new password, in code points. |
| `authn.local.policy.rule` | `object \| null` | `null` | a JSON schema for a string | Extra rule a new password must match. |
| `authn.local.policy.description` | `string` | not set | | Text a client shows next to the field. Never validated against. |
| `authn.local.policy.blocklist` | `string \| null` | `'HibpPasswordBlocklist'` outside development and test, else `null` | the class name of a registered `PasswordBlocklist` | See [Password blocklist](04-password-blocklist.md). |
| `authn.local.policy.similarity` | `boolean` | `true` | | Refuse a password too close to the login, email or name (`similar_to_identifier`). |
| `authn.local.generator.length` | `integer` | `16` | `>= 1`, within the policy bounds | Length of a generated password. |
| `authn.local.generator.characters` | `string[]` | `['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789']` | at least one non-empty string | Character groups joined into one pool. |

```ts
// config/authn.ts in your app
export default {
  authn: {
    local: {
      policy: {
        minLength: 12,
        rule: { type: 'string', pattern: '[0-9]' },
        description: 'At least 12 characters, with at least one digit.',
      },
      generator: { length: 20 },
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Policy | `LocalPasswordPolicy`, singleton, `@Injectable()` on import; injected into `LocalPasswordStrategy` and `LocalPasswordService` (`@Autoinject`), resolved per run by `authn:password --generate` | `LocalPasswordPolicy` | none shipped | Subclass and `DI.register(MyPolicy).as(LocalPasswordPolicy)` before the boot resolves the strategies. Override the protected `checkSync()` for a synchronous rule (it also gates `generate()`), or `blocklist()`. |
| Blocklist | `PasswordBlocklist`, by class name from `authn.local.policy.blocklist` | none | your `PasswordBlocklist` | See [Password blocklist](04-password-blocklist.md). |

A constructor seam reads no configuration: `new LocalPasswordPolicy({ minLength?, maxLength?, rule?, description?, blocklist?, similarity?, generator? })`. There `blocklist` is an instance (none when missing), and a missing `minLength`, `maxLength`, `similarity` or `generator` field falls back to `AUTHN_LOCAL_DEFAULTS`, the schema defaults of `authn.local`.

### Policy: custom implementation

Refuse a password that contains the product name, in any case. The rule runs in `checkSync()`, so `generate()` never returns such a password either.

```ts sample
import { DI } from '@spinajs/di';
import type { PasswordViolation } from '@spinajs/authn';
import { LocalPasswordPolicy } from '@spinajs/authn-local';

export class AcmePasswordPolicy extends LocalPasswordPolicy {
  protected checkSync(password: string): PasswordViolation[] {
    const violations = super.checkSync(password);
    if (password.toLowerCase().includes('acme') && !violations.includes('rule')) {
      violations.push('rule');
    }
    return violations;
  }
}

DI.register(AcmePasswordPolicy).as(LocalPasswordPolicy);
```

Set `authn.local.policy.description` to tell users about the extra rule: `policy()` does not describe `checkSync()` overrides.

## Important behaviour

- **Passwords are never trimmed or normalised.** Leading and trailing spaces count. A composed and a decomposed form of the same letter are different passwords of different lengths.
- **8 to 128 is a hard frame.** The schema keeps both bounds inside it, and the code refuses a `minLength` below 8 even when the schema is skipped.
- **The login bound is fixed.** A login accepts 8 to 128 code points whatever `minLength` says, so raising it does not lock anyone out. It applies to new passwords only.
- **The hard cap protects the rule and the blocklist.** Above 1024 code points neither runs.
- **The rule compiles once**, at boot when DI resolves the policy.
- **A violation tells little about the account.** Callers may show it to the user. Only `similar_to_identifier` depends on the account, and only through identifiers the caller already typed or guessed.
- **The similarity rule needs a context.** `check(password)` without one never answers `similar_to_identifier`; pass the login and email you are about to store.
- **`generate()` failing is a server fault.** It throws `UnexpectedServerError`, never a client error, because no caller can fix the configuration.

## Best practices

- Put the rule's character requirement in a top-level `pattern`: clients get it from `policy()` and can check before submitting.
- Keep `generator.characters` compatible with the rule. A rule that demands a symbol needs a symbol group in the pool.
- Call `PasswordService.check(password, { login, email })` before you create an account with a password, so a violation does not leave a half-made identity.

## Patterns and antipatterns

```ts
// Don't: a rule the default pool cannot satisfy makes generate() throw after 10 draws.
authn: { local: { policy: { rule: { type: 'string', pattern: '[!@#$%^&*]' } } } }

// Do: add the characters the rule needs to the generator pool.
authn: {
  local: {
    policy: { rule: { type: 'string', pattern: '[!@#$%^&*]' } },
    generator: { characters: ['abcdefghijkmnpqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '!@#$%^&*'] },
  },
}
```

## Examples

### Validate a password on a sign-up form before creating the account

```ts sample
import { DI } from '@spinajs/di';
import { PasswordService } from '@spinajs/authn';
import type { PasswordViolation } from '@spinajs/authn';

const MESSAGES: Record<PasswordViolation, string> = {
  too_short: 'The password is too short.',
  too_long: 'The password is too long.',
  rule: 'The password does not meet the rules.',
  blocklisted: 'This password appeared in a data breach. Pick another one.',
  similar_to_identifier: 'The password is too close to your login or email.',
};

/** Messages for the sign-up form; empty when the password is acceptable. */
export async function passwordProblems(password: string, login: string, email: string): Promise<string[]> {
  const passwords = await DI.resolve(PasswordService);
  const violations = await passwords.check(password, { login, email });
  return violations.map((v) => MESSAGES[v]);
}
```

## Related

- [Password blocklist](04-password-blocklist.md): the `blocklisted` violation.
- [Change and set](05-change-and-set.md), [Reset and invite](06-reset-and-invite.md): the flows that apply the policy.
- [CLI commands](10-cli-commands.md): `authn:password --generate` uses `generate()`.
- [`@spinajs/authn-http`](../authn-http/12-password-routes.md): `GET /auth/password/policy`.
