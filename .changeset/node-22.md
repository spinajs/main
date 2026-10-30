---
"@spinajs/di": major
---

Node 22 or newer is required by every `@spinajs/*` package.

Upgrading to 4.0 (node and build output):

- Node 22 or newer is required (`engines.node >=22.0.0` in every package). CI tests on 22 and 24.
- Packages are ESM only and build into `lib/`. `require('@spinajs/...')` no longer resolves; `import` does.
- Deep imports `@spinajs/<pkg>/lib/mjs/<path>` are now `@spinajs/<pkg>/lib/<path>`; `spinajs upgrade --to 4` rewrites them.
- `DI.setESMModuleSupport()` is a deprecated no-op; remove the call.
- Package config `system.dirs.*` entries resolve to `node_modules/@spinajs/<pkg>/lib/<sub>`; if your app overrides any of them with a `lib/mjs` path, drop the `mjs` segment.
