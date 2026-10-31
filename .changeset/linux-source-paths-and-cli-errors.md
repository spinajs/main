---
"@spinajs/http": patch
"@spinajs/http-swagger": patch
"@spinajs/di": patch
"@spinajs/cli": minor
"@spinajs/compiler": patch
"@spinajs/orm": patch
"@spinajs/util": minor
---

On POSIX a controller's captured source file kept no leading slash, so booting any controller with a source file failed. Stack frame urls now go through `fileURLToPath`, by the new `filePathOfUrl` of `@spinajs/util`. `@Autoinject`, `@LazyInject`, route arguments and the OpenAPI builder take a list built by a second copy of `@spinajs/di`. Repeated uploaded files keep the order they were sent in. A cold controller cache no longer costs a TypeScript program per file.

The CLI fails with a message when no application is found, instead of exiting 0 having done nothing. A fatal error prints its message alone and reaches the configured log targets. `manifest:diff` gained `--out`.
