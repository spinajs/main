# CLI and QR codes

The package ships two `@spinajs/cli` commands: `authn:mfa-reset` removes an account's TOTP enrolment, and `authn:mfa-qr` (alias `rbac:2fa-qr`) prints a scannable QR code for a TOTP secret or an `otpauth://` URI. `buildOtpAuthUrl` is the helper behind the QR command.

## How it works

The package config adds its compiled `cli` folder to `system.dirs.cli`, so the CLI finds both commands once the package is installed.

### `authn:mfa-reset <login>`

1. `MfaReset` injects [`OrmMigrator`](../orm/10-migrations.md) (which boots the ORM and runs its `Migration.OnStartup` boot pass first), `IdentityStore` and `TotpService`. `IdentityStore` is injected with `{ check: true }`: without a registered one the command cannot be resolved.
2. `IdentityStore.findByLogin(login)` finds the account by login or email. An unknown login throws `InvalidArgument` `no account with login <login>` and changes nothing.
3. `TotpService.adminReset(CLI_ACTOR, identity, cliContext())` removes the enrolment and the recovery codes. `CLI_ACTOR` (`{ type: 'system', id: 'cli' }`) and `cliContext()` (purpose `'request'`, `userAgent` `spinajs-cli`) come from `@spinajs/authn/contracts`. See [Disable and admin reset](05-disable-and-reset.md).
4. It logs `MFA reset for <login>` or `No MFA enrolment for <login>` on the `authn-totp` logger. It prints no secret.

```sh
npx spinajs authn:mfa-reset jane.doe@acme.example
```

### `authn:mfa-qr <secretOrUrl>`

`rbac:2fa-qr` is an alias of the command.

1. `Generate2FaQrCode` calls `buildOtpAuthUrl(secretOrUrl, options)` with `--label`, `--issuer` (default `authn.mfa.totp.issuer`) and `algorithm`, `digits` and `period` of `authn.mfa.totp`.
2. It prints the QR code to the terminal with `qrcode`, then the URI. It writes to `console.log` directly: logger prefixes would break the QR modules.
3. With `--output <file>`, it also writes a PNG and logs the file name on the `authn-totp` logger.

| Argument or option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `secretOrUrl` | yes | | A base32 secret, or a full `otpauth://` URI. |
| `-l, --label <label>` | no | `user` | Account label shown in the authenticator app. |
| `-i, --issuer <issuer>` | no | `authn.mfa.totp.issuer` | Issuer shown in the authenticator app. |
| `-o, --output <file>` | no | | Also writes the QR code to a PNG file. |

```sh
npx spinajs authn:mfa-qr "JBSW Y3DP EHPK 3PXP" --label jane.doe@acme.example --output jane-totp.png
```

### `buildOtpAuthUrl(secretOrUrl, options)`

1. Trims the input. An empty value throws `InvalidArgument`.
2. A value that starts with `otpauth://` (any case) is returned unchanged.
3. Otherwise it removes whitespace, upper-cases the secret and returns an `otpauth://totp/...` URI built by `otpauth` from `IOtpUrlOptions`: `issuer`, `label`, `algorithm`, `digits`, `period`. An invalid base32 secret throws.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authn.mfa.totp.issuer` | `string` | `'SpinaJS'` | non-empty | Default `--issuer` of `authn:mfa-qr`. |
| `authn.mfa.totp.algorithm` | `string` | `'SHA1'` | `'SHA1'`, `'SHA256'`, `'SHA512'` | Algorithm written into the URI. |
| `authn.mfa.totp.digits` | `number` | `6` | 6 to 10 | Digits written into the URI. |
| `authn.mfa.totp.period` | `number` | `30` | 1 to 300 | Period written into the URI. |
| `system.dirs.cli` | `string[]` | adds `node_modules/@spinajs/authn-totp/lib/cli` under `WORKSPACE_ROOT_PATH`, else under the working directory | | Where the CLI loads commands from. Set by the package config. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Account lookup | `IdentityStore` of `@spinajs/authn` | the registered store (`@spinajs/users`) | | Register another `IdentityStore`. |
| Reset | `TotpService`, singleton (registered as `MfaEnrolmentService`) | `TotpService` | | `adminReset` uses only `TotpMfaStep` and `AuthnAudit`. |

## Important behaviour

- `authn:mfa-reset` audits `mfa.disable` with the actor `{ type: 'system', id: 'cli' }` through `AuthnAudit`, so every registered `AuthnEventSink` gets it.
- `authn:mfa-reset` needs no `SessionIssuer`, `AuthnService` or `AuthnThrottle`: `TotpService` injects them as optional.
- `authn:mfa-qr` does not touch any stored enrolment. It renders what you pass it, so the operator sees the secret: use it for test accounts and devices you own, not to enrol users.
- `authn:mfa-qr` takes `algorithm`, `digits` and `period` from config even when they differ from what the secret was made for; a full `otpauth://` URI keeps its own.

## Best practices

- Reset a user's MFA with `authn:mfa-reset`, then let the user enrol again through `TotpService`: no operator ever holds the user's secret.

## Examples

### Build an otpauth URI for a test account

```ts sample
import { buildOtpAuthUrl } from '@spinajs/authn-totp';

export const qaDeviceUri = buildOtpAuthUrl('jbsw y3dp ehpk 3pxp', {
  issuer: 'Acme Staging',
  label: 'qa-bot@acme.example',
  algorithm: 'SHA1',
  digits: 6,
  period: 30,
});
```

## Related

- [Disable and admin reset](05-disable-and-reset.md): what `adminReset` does.
- [`@spinajs/cli`](../cli/README.md): how commands are found and run.
