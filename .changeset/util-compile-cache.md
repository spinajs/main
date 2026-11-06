---
"@spinajs/util": minor
---

New subpath `@spinajs/util/compile-cache`: `enableCompileCache()` turns on Node's module compile cache in a per-user dir (`$XDG_CACHE_HOME/spinajs/compile-cache`, else `~/.cache/spinajs/compile-cache`; `%LOCALAPPDATA%\spinajs\compile-cache` on Windows), `flushCompileCache()` writes it, and `compileCacheDir()` names the dir. On POSIX the dirs are created with mode `0700` and handed to Node by their real path. The cache stays off when one of them is a link, belongs to another user or is writable by the group or others, and when a dir above the cache root, up to `/`, belongs to neither root nor this user or is writable by the group or others, sticky or not, so a cache root below `/tmp` is refused: Node trusts the entries it finds, so a shared dir such as Node's default in the temp dir would let another local user supply the bytecode of the app's modules. `NODE_COMPILE_CACHE` and `NODE_DISABLE_COMPILE_CACHE` keep their meaning.
