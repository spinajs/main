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

Node accepts any cache entry whose source length and hash match, and it opens the cache dir by path for every module it compiles. So anyone who can write to the cache dir, or rename or replace any dir of its path while the process runs, can supply the bytecode of the modules this process loads. On POSIX the helper therefore checks the whole path, the way OpenSSH's `StrictModes` does, and returns `undefined` when any check fails:

1. The parent of the cache root is resolved to its real path (links followed). The cache dir is that real path, then the last segment of the cache root, then `spinajs/compile-cache`. This is the path Node gets, so a link swapped on the way afterwards changes nothing.
2. Every dir from that parent up to `/` must be a directory that belongs to root (uid 0) or the process's uid and is writable by neither its group nor others (`mode & 0o022` is 0). The sticky bit is no exception: each of these dirs holds a segment of the path, and the cleaners of a shared dir such as `/tmp` delete aged entries while the process runs, after which anyone can create the same path again. So a cache root below `/tmp` or `/var/tmp` is never accepted.
3. The cache root, `spinajs` and `compile-cache` are created with mode `0700` when missing, then checked with `lstat`: each must be a directory, not a link, belong to the process's uid and be writable by neither its group nor others.
4. Once the dirs exist, steps 2 and 3 run again, and the real path of the cache dir must still be the path from step 1.

Node's own default, `<os temp dir>/node-compile-cache`, fails these checks by design: on Linux every user shares it. The default `~/.cache` passes them on a usual system (`/` and `/home` belong to root with mode `755`, the home dir to the user). A home dir or `~/.cache` that the user's group can write to, as with umask `002`, leaves the cache off.

On Windows nothing is checked: the dir is created and used. What keeps it private is the ACL of the user profile, which grants access to the user, `SYSTEM` and the Administrators only, so `LOCALAPPDATA` must point at a per-user dir. One pointed at a shared dir such as `C:\Users\Public` is used as it is.
