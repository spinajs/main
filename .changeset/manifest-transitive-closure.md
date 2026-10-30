---
"@spinajs/compiler": minor
"@spinajs/manifest": patch
"@spinajs/configuration": patch
---

The app manifest lists the app's whole installed dependency closure: `locateFragments` follows `dependencies`, `optionalDependencies` and installed `peerDependencies` transitively, through packages without a fragment, so a config file that only a transitive `@spinajs` package ships loads in manifest mode too. In manifest mode, package config files merge in the walk's order across install levels (nearer `node_modules` first, then by name). `packageRootOf` finds an ESM-only package whose `exports` hide `package.json` and have no `require` condition. A JS config file's cached module object is no longer tagged with `__file__`, so a second configuration load in the same process lists each file once.
