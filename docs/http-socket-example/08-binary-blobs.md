# Binary blobs

`blob.put` stores raw bytes and answers their SHA-256 hash; `blob.get` returns the bytes for a hash. Together they show binary payloads and binary results over socket.io, with no base64 step.

## How it works

1. The client sends `blob.put` with `{ bytes }`, a `Uint8Array` (or `ArrayBuffer`). socket.io sends it as a binary attachment.
2. The dispatcher checks the payload size against `http.socket.maxPayloadBytes`; binary parts count by their byte length.
3. `BlobSocket.put` checks `req?.bytes instanceof Uint8Array`; anything else throws `InvalidArgument('bytes must be binary')`, which the client sees as `invalid_argument`. On the server a binary part arrives as a `Buffer`, which is a `Uint8Array`.
4. `NotesStore.putBlob(bytes)` hashes with SHA-256, stores a copy under the lowercase hex hash, and returns it. The reply is `{ hash }`.
5. The client sends `blob.get` with `{ hash }`. The schema requires `^[0-9a-f]{64}$`.
6. `BlobSocket.get` returns the stored `Uint8Array`, or throws `ResourceNotFound('no blob <hash>')`, which the client sees as `not_found`.
7. The client receives a `Buffer` in Node and an `ArrayBuffer` in browsers. `toBytes()` turns either into a `Uint8Array`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.socket.maxPayloadBytes` | `number` | `1048576` (1 MiB) | Positive integer | Largest command payload; above it the command fails with `resource_exhausted`, not retryable |

socket.io's `maxHttpBufferSize` is set to twice `maxPayloadBytes`. A frame above that is not answered: socket.io drops the connection.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `BlobSocket` | `BaseSocketController` list entry, singleton | `BlobSocket` | Your own `@SocketController('blob')` class after removing `BlobSocket` | Add commands in another controller; change storage through [`NotesStore`](09-notes-store.md) |
| Blob storage | `NotesStore.putBlob()` / `blob()`, singleton | In-memory `Map` | A `NotesStore` subclass | Override `putBlob` and `blob`; see [Notes store](09-notes-store.md#notesstore-custom-implementation) |

## Important behaviour

- A blob must fit one frame. There is no chunked upload; for larger data use a stream reply for downloads and several commands for uploads.
- `blob.put` has no ajv schema, because ajv does not describe a `Uint8Array`; the type check is in the handler.
- The store is content-addressed: putting the same bytes twice answers the same hash and keeps one copy.
- `putBlob` copies the bytes (`new Uint8Array(bytes)`), so the caller may reuse its buffer.
- Blobs are never removed. Memory grows with every distinct upload until the process exits.
- Any signed-in connection can read any blob whose hash it knows.

## Best practices

- Wrap every binary result with `toBytes()` before reading it; code written against `Buffer` breaks in a browser.
- Lower `http.socket.maxPayloadBytes` to the largest blob you accept, so oversized uploads fail with `resource_exhausted` instead of dropping the connection.

## Patterns and antipatterns

```ts
// Don't: Buffer methods exist only in Node; in a browser `back` is an ArrayBuffer
const text = (await notes.command('blob.get', { hash })).toString('utf8');

// Do
const text = new TextDecoder().decode(toBytes(await notes.command('blob.get', { hash })));
```

## Examples

### Upload an attachment and verify the round trip

```ts sample
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connectNotes, toBytes } from '@spinajs/http-socket-example/lib/mjs/client.js';
import { SocketException } from '@spinajs/http-socket-client';

async function uploadAttachment(url: string, path: string, file: string): Promise<string> {
  const notes = connectNotes(url, path, 'alice-token');

  try {
    const bytes = new Uint8Array(await readFile(file));
    const { hash } = await notes.command('blob.put', { bytes }, { whenOffline: 'wait' });

    if (hash !== createHash('sha256').update(bytes).digest('hex')) {
      throw new Error('server hash differs');
    }

    const back = toBytes(await notes.command('blob.get', { hash }));
    console.log(`${file}: ${back.byteLength} bytes stored as ${hash.slice(0, 12)}`);
    return hash;
  } catch (error) {
    if (error instanceof SocketException && error.code === 'resource_exhausted') {
      throw new Error(`${file} is larger than the server's http.socket.maxPayloadBytes`);
    }
    throw error;
  } finally {
    notes.close();
  }
}

void uploadAttachment('http://127.0.0.1:3000', '/socket.io', './invoice.pdf');
```

## Related

- [Socket controllers](06-socket-controllers.md): how `BlobSocket` is registered.
- [Notes client](10-notes-client.md): `toBytes()`.
- [`@spinajs/http-socket`](../http-socket/README.md): payload limits and error mapping.
