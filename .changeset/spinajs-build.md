---
"@spinajs/cli": minor
"@spinajs/compiler": patch
---

New `spinajs build` command (`--tsconfig`, `--out`, `--schemas` / `--no-schemas`, `--fail-on-warning`) that analyzes the application and writes `app.manifest.json`. Every workspace package now declares `spinajs.manifest` and ships `lib/manifest.fragment.json`, produced by the root build. `locateFragments` finds dependencies hoisted into an ancestor `node_modules` even when their `exports` hide `package.json`.
