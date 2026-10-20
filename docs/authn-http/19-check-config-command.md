# `authn:check-config` command

`authn:check-config` reports what the `authn.*` configuration gets wrong, through `checkAuthnConfig()` of [`@spinajs/authn`](../authn/README.md), for example an enrolled MFA step that `authn.mfa.steps` lacks. It prints key names, never secret values. The shipped config adds the package's `cli` directory to `system.dirs.cli`, so the command is available in every app that installs `@spinajs/authn-http`.

## How it works

1. `AuthnCheckConfig.execute()` imports each installed provider package: `@spinajs/authn-local`, `@spinajs/authn-token`, `@spinajs/authn-keys`, `@spinajs/authn-oidc`, `@spinajs/authn-totp`. A CLI process loads no package root, so without this every listed strategy would look missing. A package that is not installed is skipped; one that is installed but fails to load stops the command with its error.
2. It imports `@spinajs/authn` and runs `checkAuthnConfig(container)`. The check opens the authn store (the app database when `@spinajs/authn-orm` is loaded) to look for enrolled MFA steps.
3. It prints one line per finding to stdout, `<level> <topic>: <message>`, or `authn:check-config: no findings`.
4. Any finding of level `error` sets the exit code to 1.

## Examples

### Check the configuration in CI before a deploy

```sh
npx spinajs authn:check-config --env production
```

The `spinajs` bin exits with the exit code the command set, so a CI step fails on any `error` finding. See [Running the CLI](../cli/01-running-the-cli.md) for `--app`, `--env` and `--apppath`.

## Important behaviour

- The output is a report on stdout, not log output.
- Messages name configuration keys, never their values.
- The command reads the same configuration files as the app; run it with the app's environment variables.

## Related

- [`@spinajs/authn`](../authn/13-configuration-and-boot-checks.md): `checkAuthnConfig()` and the boot checks.
- [Migration guide: keys that other config files own](../authz/migration-guide.md#34-keys-that-other-config-files-own): what the boot checks and the command look for.
- [`@spinajs/cli`](../cli/README.md): how CLI commands are found and run.
