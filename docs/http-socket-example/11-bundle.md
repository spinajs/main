# Single-file bundle

`npm run bundle` (in `packages/http-socket-example`) compiles the package and writes `dist/bundle`:

| File | Content |
| --- | --- |
| `main.mjs` | The app with every dependency inlined; starts the notes server, `GET /health` answers `{"status":"ok"}`. |
| `app.manifest.json` | The manifest built from `lib/`. |
| `package-roots.json` | Package name to directory, read through `SPINAJS_PACKAGE_ROOTS`. |
| `packages/<pkg>/<outDir>/config/*.js` | Package config files, standalone module copies beside the bundle. |

The directory runs with no `node_modules` at all: `node main.mjs` (`PORT` picks the port, default a free one). `main.mjs` defaults `SPINAJS_MANIFEST_MODE` to `require` and locates the manifest, the package roots and the app root from its own directory. See [the manifest docs](../manifest/README.md) for the resolve rules.
