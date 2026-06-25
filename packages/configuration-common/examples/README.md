# `@spinajs/configuration-common` examples

Each file is self-contained and imports from `@spinajs/configuration-common`
exactly as application code would. They focus on the templating engine
(`format()` + variables) and the configuration contracts exposed by this
package.

| File | Shows |
| --- | --- |
| [01-format-basics.ts](01-format-basics.ts) | `${name}` / `${name:option}` substitution, custom vars vs. built-ins, recursive `message`, unknown-var handling |
| [02-builtin-variables.ts](02-builtin-variables.ts) | every built-in variable: `date`/`time`/`datetime`, UTC variants, `timestamp`, `env`, `path`, system info, `uuid` |
| [03-conditional-blocks.ts](03-conditional-blocks.ts) | conditional blocks `${?var} ... ${/var}` and how they compose |
| [04-custom-variable.ts](04-custom-variable.ts) | defining your own global `${...}` via `@Injectable(ConfigVariable)` |
| [05-config-var-protocol.ts](05-config-var-protocol.ts) | protocol-backed values with `ConfigVarProtocol` and lazy `ConfigVar` |

## Running an example

The examples are plain TypeScript scripts:

```bash
npx ts-node examples/01-format-basics.ts
```

`format()` and the built-in variables work standalone; examples `04` and `05`
register classes in the DI container — in a real app these are discovered
automatically when the module is loaded.
