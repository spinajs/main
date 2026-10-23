# Streams

Two pass-through `Transform` streams for data on its way to a provider: `DigestStream` hashes every byte it passes on, and `ByteLimitStream` fails once more than a set number of bytes went through. Put them in a pipeline between a source and `writeStream()`, so you hash and cap a body without reading it twice.

## How it works

1. You build them per stream: `new DigestStream('sha256')`, `new ByteLimitStream(maxBytes)`.
2. They sit in a pipeline: `pipeline(source, limit, digest, await provider.writeStream(key))`.
3. `DigestStream._transform()` updates the hash, counts the bytes and passes the chunk on unchanged. `_flush()` computes the digest when the input ends.
4. `ByteLimitStream._transform()` passes a chunk on while the total stays within `maxBytes`. The chunk that would go over is dropped, and the stream fails with `LimitExceeded`.

## Services and extension points

Plain classes, exported from `@spinajs/fs`; nothing is registered in DI.

| Member | Meaning |
| --- | --- |
| `new DigestStream(algorithm = 'sha256')` | Any algorithm Node's `crypto.createHash` accepts; an unknown one throws when the stream is built. |
| `DigestStream.bytes` | Bytes passed on so far. |
| `DigestStream.digest(encoding = 'hex')` | `'hex'` or `'base64'` of the whole input. Throws `InvalidOperation` before the stream finished. |
| `new ByteLimitStream(maxBytes)` | `maxBytes` must be a non-negative safe integer, else `InvalidArgument`. |
| `ByteLimitStream.bytes` | Bytes passed on so far; never more than `maxBytes`. |

`LimitExceeded` is in `@spinajs/exceptions`. In an `@spinajs/http` route it answers `413`.

## Important behaviour

- **The digest exists only after the input ended.** Read `digest()` after the pipeline resolved, not on `'data'`.
- **`ByteLimitStream` fails on byte `maxBytes + 1`**, so exactly `maxBytes` bytes pass. It does not check that enough bytes arrived: compare `bytes` with the expected count yourself.
- **The over-limit chunk is dropped whole.** The destination never receives a partial chunk past the limit, but it may hold the bytes before it: remove the partial object after a `LimitExceeded`.
- **`FileHasher.hashStream()` consumes its stream.** Use `DigestStream` when the bytes must also reach a destination.

## Examples

### Store an import file of at most 20 MiB and return its SHA-256

```ts sample
import { LimitExceeded } from '@spinajs/exceptions';
import { ByteLimitStream, DigestStream, getFs } from '@spinajs/fs';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const closed = (out: Writable) =>
  new Promise<void>((resolve, reject) => {
    out.once('close', () => resolve());
    out.once('error', reject);
  });

export async function storeImport(source: NodeJS.ReadableStream, key: string): Promise<{ sha256: string; bytes: number }> {
  const imports = getFs('imports');
  const limit = new ByteLimitStream(20 * 1024 * 1024);
  const digest = new DigestStream('sha256');
  const out = await imports.writeStream(key, { exclusive: true });
  const done = closed(out);
  done.catch(() => undefined);

  try {
    await pipeline(source, limit, digest, out);
    await done;
  } catch (err) {
    if (err instanceof LimitExceeded) await imports.rm(key);
    throw err;
  }
  return { sha256: digest.digest('hex'), bytes: digest.bytes };
}
```

## Related

- [File operations](02-file-operations.md#write-stream-options): `writeStream()` options and when to wait for `'close'`.
- [File hashing](09-file-hashing.md): `FileHasher` for files already stored.
- [Raw request bodies and digests](../http/24-raw-body-and-digests.md): the same streams under `@RequestStream()`.