# Middlewares on the FTP provider

An `FsMiddleware` runs before and after every public file method of every provider, `fsFTP` included. Use it to add guards or auditing to an FTP server without subclassing `fsFTP`. `FsMiddleware` comes from `@spinajs/fs`: the full contract is in [Middlewares](../fs/07-middlewares.md). This page covers what matters when the target is FTP.

## How it works

1. You register a class extending `FsMiddleware` under the `FsMiddleware` token: `@Injectable(FsMiddleware)`.
2. You call a method on the FTP provider, eg. `getFs('ftp-archive').write('a.txt', 'x')`. `getFs()` returns the `fsFTP` instance itself.
3. The base `fs` class normalises the path and resolves `Array.ofType(FsMiddleware)`, sorted by `order` ascending.
4. Middlewares whose `isEnabled(fs)` answers `true` for the provider (or a destination provider) run `before(ctx)`. A throw aborts the action before any FTP command is sent.
5. `fsFTP`'s protected `doX` hook runs inside the action frame, then the `after` hooks run.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `FsMiddleware` | `FsMiddleware`, every registration, resolved as `Array.ofType(FsMiddleware)` on every top-level action; singleton unless decorated otherwise | none | `AuthzFsMiddleware` (`@spinajs/authz-fs`, `order` `100`) | `@Injectable(FsMiddleware)`. Every registration runs; there is no replacing. |

### `FsMiddleware`: custom implementation

This middleware makes the `ftp-archive` server read-only. `before` refuses every target on that provider that asks for `write` or `delete` access, so `rename()`, `rm()` and `move()` out of it are refused too. `copy()` to a local provider still works: its source asks for `read` only.

```ts sample
import { Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { fs, FsActionContext, FsMiddleware, getFs } from '@spinajs/fs';
import { fsFTP } from '@spinajs/fs-ftp';

const ARCHIVE = 'ftp-archive';

@Injectable(FsMiddleware)
export class ReadOnlyArchiveFtp extends FsMiddleware {
  public isEnabled(target: fs): boolean {
    return target instanceof fsFTP && target.Name === ARCHIVE;
  }

  public async before(ctx: FsActionContext): Promise<void> {
    for (const target of ctx.targets) {
      if (target.fs.Name === ARCHIVE && target.access.some((a) => a === 'write' || a === 'delete')) {
        throw new InvalidOperation(`FTP archive is read-only, ${ctx.action}(${target.path}) is not allowed`);
      }
    }
  }
}

// fs.providers entry: { service: 'fsFTP', name: 'ftp-archive', host: 'archive.example.com', user: 'reader', password: '...' }

export async function pullContract(contractId: string): Promise<string> {
  const archive = getFs(ARCHIVE);
  const local = getFs('local');

  await archive.copy(`contracts/${contractId}.pdf`, `contracts/${contractId}.pdf`, local);
  return (await archive.exists(`contracts/${contractId}.pdf`)) ? 'copied' : 'missing';
}
```

## Important behaviour

- Middlewares see **every** provider. Filter in `isEnabled(fs)` with `fs instanceof fsFTP` or by `fs.Name`.
- `fsFTP` reads `fs-temp` for every download, and those calls run inside the action frame. A middleware on `fs-temp` does not see them, so refusing writes on `fs-temp` does not block FTP downloads.
- Methods of `fsFTP` call each other (`read()` calls `download()`, `exists()` calls `stat()`). Only the outer call runs the middlewares.
- `upload(..., { exclusive: true })`: every `before` runs first, then the provider checks `exists()`. See [Middlewares](../fs/07-middlewares.md#important-behaviour).
- `order` against `AuthzFsMiddleware` (`100`): both see every call. A lower `order` runs its `before` first, a higher one after the authorization check.
- A middleware cannot hold the FTP connection or queue commands. To serialise calls, subclass: [Serialize concurrent calls](03-extending-the-ftp-provider.md#serialize-concurrent-calls).

## Best practices

- Keep per-server switches by provider name (`target.fs.Name`), not by a custom config key: a middleware has no access to the provider entry.
- Check `ctx.targets`, not only `ctx.fs`: `copy` and `move` out of `fsFTP` have a destination on another provider.

## Patterns and antipatterns

```ts
// Don't: blocks every provider, so local writes fail as well
public async before(ctx: FsActionContext): Promise<void> {
  throw new InvalidOperation('read-only');
}

// Do: scope the middleware to the FTP archive
public isEnabled(target: fs): boolean {
  return target instanceof fsFTP && target.Name === 'ftp-archive';
}
```

## Related

- [`FsMiddleware`](../fs/07-middlewares.md): the contract, ordering, streams and the action frame.
- [FTP provider](01-ftp-provider.md): where the middlewares run in the boot flow.
- [File operations](02-file-operations.md): the one-command-at-a-time rule.
- [Extending the FTP provider](03-extending-the-ftp-provider.md): subclass instead of adding a middleware.
