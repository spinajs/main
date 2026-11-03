# Compile cache

`@spinajs/util/compile-cache` turns on Node's module compile cache in a per-user dir. A launcher calls it before it imports the app, so the next start reuses the compiled modules. [The http docs](../http/README.md#compile-cache) show the launcher; the `spinajs` bin and the `@spinajs/http-socket-example` bundle use it.

```ts
import { enableCompileCache, flushCompileCache } from '@spinajs/util/compile-cache';

enableCompileCache();
await import('./main.js');
flushCompileCache();
```

| Function | Behaviour |
| --- | --- |
| `enableCompileCache()` | Turns the cache on in `compileCacheDir()` for every module loaded after the call. Leaves it off without a word when that is `undefined`, when the dir cannot be created, or on Node 22.0 |
| `flushCompileCache()` | Writes what the cache holds so far. A server calls it once it listens: Node writes the cache at exit, which a server stopped by a signal never reaches. No-op before Node 22.10 |
| `compileCacheDir(host?)` | The dir, created when missing, or `undefined` for "leave it off". `host` (`env`, `platform`, `homedir`, `uid`) defaults to the running process |

## Which dir

| Case | Result |
| --- | --- |
| `NODE_DISABLE_COMPILE_CACHE` set | `undefined`, nothing is created |
| `NODE_COMPILE_CACHE` set | `undefined`: Node has already turned the cache on in that dir at start-up |
| Windows | `%LOCALAPPDATA%\spinajs\compile-cache`, else `<home>\AppData\Local\spinajs\compile-cache` |
| POSIX | `$XDG_CACHE_HOME/spinajs/compile-cache` when `XDG_CACHE_HOME` is absolute, else `~/.cache/spinajs/compile-cache` |

On POSIX each dir from the cache root down is created with mode `0700` when missing, and checked with `lstat`. It must be a directory (not a link), belong to the process's uid and not be writable by the group or others. If any dir fails the check, the result is `undefined`. Node accepts any cache entry whose source length and hash match, so a dir another user can write to would let that user supply the bytecode of the modules this process loads. That is also why Node's own default, `<os temp dir>/node-compile-cache`, is not used: on Linux every user shares it.
