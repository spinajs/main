---
"@spinajs/cli": minor
---

The `spinajs` bin turns on Node's compile cache before it loads the CLI, so the next run reuses the compiled framework modules. The cache lives in a per-user dir (`$XDG_CACHE_HOME/spinajs/compile-cache`, else `~/.cache/spinajs/compile-cache`; `%LOCALAPPDATA%\spinajs\compile-cache` on Windows), never in the temp dir that every user shares on Linux. On POSIX the cache stays off when a dir of that path, or any dir above it up to `/`, is open to another user (so never below `/tmp`). `NODE_COMPILE_CACHE` picks another dir, `NODE_DISABLE_COMPILE_CACHE=1` turns it off, and a cache dir that cannot be created leaves it off without a message. `lib/cli.js` is now a launcher and the CLI itself moved to `lib/run-cli.js`. Nothing else changes: same commands, output and exit codes.
