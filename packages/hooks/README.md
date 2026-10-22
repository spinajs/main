# `@spinajs/hooks`

Action hooks for SpinaJS: `before`, `after` and `failed` hooks around named actions, resolved through the DI
container. A package declares its actions and runs them through `Hooks.run`; an application registers
`ActionHook` classes to change the inputs an action declares mutable, refuse it, or observe its result.

Configuration (`hooks.*`):

| Key | Default | Meaning |
|---|---|---|
| `hooks.timeoutMs` | 5000 | Bound per hook call, 1 to 60000 |
| `hooks.maxDepth` | 8 | Nested action runs, 1 to 32 |

Guides: [`docs/hooks`](../../docs/hooks/README.md).
