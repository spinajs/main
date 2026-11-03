---
"@spinajs/cli": minor
---

The `spinajs` bin turns on Node's compile cache before it loads the CLI, so the next run reuses the compiled framework modules. The cache lives in `NODE_COMPILE_CACHE`, else `<os temp dir>/node-compile-cache`; `NODE_DISABLE_COMPILE_CACHE=1` turns it off, and a cache dir that cannot be written leaves it off without a message. `lib/cli.js` is now a launcher and the CLI itself moved to `lib/run-cli.js`. Nothing else changes: same commands, output and exit codes.
