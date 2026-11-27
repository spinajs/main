---
"@spinajs/cli": minor
"@spinajs/tenancy": minor
---

`@spinajs/cli`: `CliCommandHook` wraps the action of every command (`order`, the lowest outermost) and may add options every command accepts (`options()`); none is registered by default, and without one a command runs as before. A hook option is always the program's value, never a command's own option of the same name or its default.

`@spinajs/tenancy/cli`: every `spinajs` command accepts `--tenant <id>` (the command runs inside that tenant once the registry knows it as active) or `--all-tenants <reason>` (across all tenants, the reason logged); with neither it runs with no tenant scope. Either option given twice, or both together, stops the command before it runs. The CLI finds the hook through the package's `system.dirs.cli`; the application imports nothing. A command that declares its own `--tenant` or `--all-tenants` no longer receives a value for it.
