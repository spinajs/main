---
"@spinajs/http": major
"@spinajs/reflection": major
---

`typescript` and `glob` are optional peer dependencies: `@spinajs/http` no longer installs `typescript`, `@spinajs/reflection` no longer installs `typescript` or `glob`.

Migration: an app without a manifest (`system.manifest.mode` `off`, the default) installs `typescript` as a dependency, ships a controller cache built ahead of time with `spinajs http:controllers:cache`, or switches to the manifest (`spinajs build`, mode `prefer` or `require`); otherwise the first controller the cache has to parse fails the boot with `NoControllerMetadata` naming the peer. An app that scans directories with `@ResolveFromFiles` / `@ListFromFiles` installs `glob` `^8` (`@spinajs/configuration` still depends on it today); without it the first scan throws `ReflectionException`. `TypescriptCompiler` (`@spinajs/reflection/typescript`) needs `typescript` installed.
