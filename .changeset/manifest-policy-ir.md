---
"@spinajs/compiler": minor
"@spinajs/cli": minor
"@spinajs/manifest": patch
---

`spinajs build` records the app's compiled authorization policy in the manifest: when `authz.ir.json` (written by `spinajs authz:compile`; `--authz-ir <path>` names another file) is in the application root, the `authz` section carries its canonical text as `ir` and its SHA-256 as `policyHash`, recomputed from the file. Without the file the build reports `AUTHZ010` (info, reworded: it named a command that does not exist); a file that is not a valid policy IR is reported as `AUTHZ011` (warning) and left out. `buildAppManifest` takes the policy as `BuildAppOptions.policy`.
