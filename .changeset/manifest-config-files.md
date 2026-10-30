---
"@spinajs/manifest": minor
"@spinajs/compiler": minor
---

Fragments and manifests list each package's built config files: `package.configFiles` / `packages[].configFiles`, relative to the package `outDir` (`config/log.js`), collected by the compiler from `src/config/**`. The field is optional; a manifest built before it still loads (the runtime then globs that package's one config dir).
