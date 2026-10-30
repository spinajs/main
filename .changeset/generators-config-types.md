---
"@spinajs/compiler": minor
"@spinajs/configuration-common": minor
"@spinajs/cli": minor
---

Typed configuration: `generateConfigDeclarations` in `@spinajs/compiler` writes a `ConfigPaths` declaration file from the manifest, and `@spinajs/configuration-common` gains the `ConfigPaths` interface with typed `get` overloads so `config.get('hooks.timeoutMs')` returns `number`. `spinajs generate:config-types` writes the file.
