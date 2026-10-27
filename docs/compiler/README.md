# @spinajs/compiler

Build-time analyzer that reads a package's TypeScript source through its `tsconfig` and emits a `ManifestFragment` (services, controllers, routes, models, migrations, schedules, CLI commands, queue messages and more). `analyzePackage` produces the fragment for one package; `buildAppManifest` merges the application fragment with the fragments shipped by its dependencies into `app.manifest.json`. The analyzer uses the in-process TypeScript 5.9 API (pinned `~5.9.0`) and never executes user code.
