# `@spinajs/codemods`

ts-morph codemods for SpinaJS major upgrades. Normally run through the CLI:

```bash
npm i -D @spinajs/codemods
npx spinajs upgrade --to 4 --dry-run   # list the files that would change
npx spinajs upgrade --to 4             # rewrite them
```

Programmatic use:

```ts
import { runTransforms, V4_TRANSFORMS } from '@spinajs/codemods';

const { changedFiles } = await runTransforms({ cwd: process.cwd(), transforms: V4_TRANSFORMS, dryRun: true });
```

The 4.0 transforms:

- `lib-mjs-imports`: `@spinajs/<pkg>/lib/mjs/...` becomes `@spinajs/<pkg>/lib/...`; `.../lib/mjs/index.js` becomes `@spinajs/<pkg>`.
- `esm-module-support`: removes `DI.setESMModuleSupport()` and the `typeof module !== 'undefined'` cjs/mjs switch.
- `problem-json-note`: adds a TODO above each `@HandleException` usage (error bodies are `application/problem+json` in 4.0). A note only, no rewrite.

See [Upgrading to 4.0](../../docs/upgrading/4.0.md).
