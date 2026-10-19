# Decorating the FTP provider

An `FsDecorator` wraps provider instances after `fsService` creates them, so you can add guards, queues or auditing to `fsFTP` without subclassing it. `FsDecorator` comes from `@spinajs/fs`; this page covers what matters when the wrapped provider is FTP.

## How it works

1. You register a class extending `FsDecorator` under the `FsDecorator` token: `@Injectable(FsDecorator)` or `DI.register(MyDecorator).as(FsDecorator)`.
2. `fsService.resolve()` creates and publishes every raw provider, `fsFTP` included, and `fs-temp`.
3. `fsService.decorate()` resolves `Array.ofType(FsDecorator)` once and sorts it by `order`, ascending.
4. For each provider, it calls `decorate(instance, config)` on every decorator in turn; each one receives the previous result and the provider's config entry.
5. The final result replaces the raw instance under the provider's `name`. `getFs()`, `@FileSystem()` and `fs://` URIs hand out the wrapped instance.
6. If any `decorate()` throws, `fsService` unpublishes every provider and throws `ResolveException('Cannot decorate file provider <name>: ...')`. No raw provider stays reachable.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Provider decorator | `FsDecorator`, resolved as a list (`Array.ofType(FsDecorator)`) once, during `fsService.resolve()` | none registered | `AuthzFsDecorator` (`@spinajs/authz-fs`, `order` 100) | Extend `FsDecorator`, set `order`, return a wrapper from `decorate()`; register before `fsService` resolves |

`FsDecorator` members:

| Member | Meaning |
| --- | --- |
| `readonly order: number` | Position in the chain; lower runs first and ends up innermost |
| `decorate(instance: fs, config: IProviderConfiguration): fs` | Return `instance` to leave a provider alone, or a wrapper to replace it. `config` is the raw `fs.providers` entry, with every custom key you put there |

## Important behaviour

- Decorators see **every** provider. Filter with `instance instanceof fsFTP` or on `config.service` before wrapping.
- `fsFTP` reads `fs-temp` through a lazy getter on every call, so it uses the **decorated** `fs-temp`. A guard that blocks writes on `fs-temp` breaks every FTP download.
- Methods of `fsFTP` call each other (`read()` calls `download()`, `exists()` calls `stat()`). A `Proxy` that invokes the method with the raw instance as `this` intercepts only the outer call; one that binds the proxy intercepts the inner calls too.
- Decorators are resolved once. A decorator registered after `fsService` resolved is never applied.

## Best practices

- Keep per-provider switches in the provider's own config entry (`readOnly: true`) and read them from `config` in `decorate()`.
- Use `Reflect.get(target, prop, receiver)` in a `Proxy` so the `Name` getter and the `fs-temp` getter keep working.
- Choose `order` against `AuthzFsDecorator` (100). A lower `order` wraps first and sits closer to the raw provider, so it sees only calls the guard let through; a higher one sees every call before the guard.

## Patterns and antipatterns

```ts
// Don't: wraps fs-temp too; every fsFTP download through fs-temp now throws
decorate(instance: fs) {
  return readOnly(instance);
}

// Do
decorate(instance: fs, config: IProviderConfiguration) {
  return instance instanceof fsFTP && (config as ArchiveConfig).readOnly ? readOnly(instance) : instance;
}
```

## Examples

### Make the archive FTP server read-only

```ts sample
import { Injectable } from '@spinajs/di';
import { FsDecorator, fs, IProviderConfiguration } from '@spinajs/fs';
import { fsFTP } from '@spinajs/fs-ftp';
import { IOFail } from '@spinajs/exceptions';

type ReadOnlyAware = IProviderConfiguration & { readOnly?: boolean };

const MUTATING = new Set(['write', 'append', 'upload', 'writeStream', 'move', 'rename', 'rm', 'mkdir']);

@Injectable(FsDecorator)
export class ReadOnlyFtpDecorator extends FsDecorator {
  readonly order = 10;

  decorate(instance: fs, config: IProviderConfiguration): fs {
    if (!(instance instanceof fsFTP) || !(config as ReadOnlyAware).readOnly) {
      return instance;
    }

    return new Proxy(instance, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        // copy() with a destination provider leaves this server untouched
        const blocked = (args: unknown[]) => MUTATING.has(prop as string) || (prop === 'copy' && args[2] === undefined);

        if (typeof value !== 'function') {
          return value;
        }

        return (...args: unknown[]) => {
          if (blocked(args)) {
            throw new IOFail(`File provider ${config.name} is read-only, ${String(prop)}() is not allowed`);
          }
          return value.apply(target, args);
        };
      },
    });
  }
}

// fs.providers entry:
// { service: 'fsFTP', name: 'ftp-archive', host: 'archive.example.com', user: 'reader', password: '...', readOnly: true }
```

### Serialize concurrent calls

`basic-ftp` runs one command at a time and `fsFTP` does not queue. This decorator chains every call on an FTP provider behind the previous one. For `readStream()` the queue waits until the returned stream finishes.

```ts sample
import { finished } from 'stream/promises';
import { Injectable } from '@spinajs/di';
import { FsDecorator, fs, getFs, IProviderConfiguration } from '@spinajs/fs';
import { fsFTP } from '@spinajs/fs-ftp';

const QUEUED = new Set([
  'download', 'read', 'readStream', 'write', 'append', 'upload', 'exists', 'dirExists', 'stat', 'isDir',
  'list', 'mkdir', 'rename', 'move', 'copy', 'rm', 'zip', 'unzip',
]);

@Injectable(FsDecorator)
export class FtpQueueDecorator extends FsDecorator {
  readonly order = 50;

  decorate(instance: fs, _config: IProviderConfiguration): fs {
    if (!(instance instanceof fsFTP)) {
      return instance;
    }

    let tail: Promise<unknown> = Promise.resolve();

    return new Proxy(instance, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);

        if (typeof prop !== 'string' || !QUEUED.has(prop) || typeof value !== 'function') {
          return value;
        }

        return (...args: unknown[]) => {
          // the raw instance as `this`: inner calls such as read() -> download() bypass the queue
          const run = tail.then(() => value.apply(target, args));

          tail = run.then(
            async (result) => {
              if (prop === 'readStream') {
                await finished(result as NodeJS.ReadableStream).catch(() => undefined);
              }
            },
            () => undefined,
          );

          return run;
        };
      },
    });
  }
}

// now safe: the writes run one after another on the single FTP connection
export async function publishAll(files: { name: string; body: string }[]) {
  const ftp = getFs('ftp-partner');
  await Promise.all(files.map((f) => ftp.write(`incoming/${f.name}`, f.body, 'utf-8')));
}
```

## Related

- [FTP provider](01-ftp-provider.md): where decorators run in the boot flow.
- [File operations](02-file-operations.md): the one-command-at-a-time rule the queue enforces.
- [Extending the FTP provider](03-extending-the-ftp-provider.md): subclass instead of wrap.
- [`@spinajs/fs`](../fs/README.md): `FsDecorator` and `fsService` for every provider type.
