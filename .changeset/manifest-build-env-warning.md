---
"@spinajs/manifest": minor
"@spinajs/compiler": minor
"@spinajs/cli": minor
"@spinajs/configuration": minor
---

`spinajs build` records the `APP_ENV` it read the app's `system.dirs` under as `buildEnv` (additive, `MANIFEST_VERSION` stays 2; a build without configuration records nothing). At boot in `prefer` and `require`, a running `APP_ENV` that differs from the recorded one logs a single warning naming both and how to rebuild; it never fails the boot, and `off` or a manifest without `buildEnv` stay silent.
