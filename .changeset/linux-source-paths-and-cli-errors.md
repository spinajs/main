---
"@spinajs/http": patch
"@spinajs/di": patch
"@spinajs/cli": minor
"@spinajs/compiler": patch
---

On POSIX a controller's captured source file kept no leading slash, so booting any controller with a source file failed. `@Autoinject` and `@LazyInject` take a list built by a second copy of `@spinajs/di`. The CLI prints a fatal error instead of exiting silently, works outside an application, and `manifest:diff` gained `--out`.
