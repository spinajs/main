# Notes store

`NotesStore` holds the documents and blobs of the example in memory. Both controllers inject the same instance. It is enough to show the protocol, **not** a storage design: one process, no persistence, no limits.

## How it works

1. `@Injectable()` registers `NotesStore` as itself when `store.js` is imported. Without a lifetime decorator it is a singleton.
2. `NotesSocket` and `BlobSocket` inject it with `@Autoinject() protected Store: NotesStore`; `startNotesServer` returns it as `INotesServer.store`.
3. `doc(docId)` returns the document, creating it on first access with version 1 and `NOTES_PER_DOC` (100) notes: `{ id: '<docId>-<i>', text: 'note <i>' }`.
4. `edit(docId, entity)` replaces the note with the same `id`, or appends it, then increments `version` and returns it.
5. `putBlob(bytes)` stores a copy under its SHA-256 hex hash and returns the hash; `blob(hash)` returns the bytes or `undefined`.
6. `DI.clearCache()` in `startNotesServer` drops the instance, so each server start gets an empty store.

### API

| Member | Signature | Meaning |
| --- | --- | --- |
| `doc` | `(docId: string) => INoteDoc` | Document, created on first access |
| `edit` | `(docId: string, entity: NoteEntity) => number` | Upsert a note; returns the new version |
| `putBlob` | `(bytes: Uint8Array) => string` | Store bytes; returns the SHA-256 hex hash |
| `blob` | `(hash: string) => Uint8Array \| undefined` | Stored bytes |
| `snapshotStarts` | `readonly number[]` | First chunk of each snapshot stream, for the tests |
| `docs`, `blobs` | protected `Map` | The storage; a subclass may use them |
| `chunkCount(entities)` | function | `Math.ceil(entities.length / ENTITIES_PER_CHUNK)` |
| `ENTITIES_PER_CHUNK` | `5` | Notes per snapshot chunk |
| `NOTES_PER_DOC` | `100` | Notes in a new document |

`INoteDoc` is `{ version: number; entities: NoteEntity[] }`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `NotesStore` | `NotesStore` (the class itself), singleton; registered by `@Injectable()` at import | `NotesStore` | none shipped | Subclass, override `doc`, `edit`, `putBlob`, `blob`; `DI.register(MyStore).as(NotesStore)` after importing `store.js` and before `startNotesServer()` |

### NotesStore: custom implementation

Replace the store to add limits, persistence or auditing. Every public method is meant to be overridden; call `super` to keep the in-memory behaviour. Register the subclass after the example's modules are imported, so it is the last registration under `NotesStore`; `startNotesServer` keeps registrations, so it survives the cache reset. Controllers then receive the subclass through `@Autoinject()`.

```ts sample
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import type { NoteEntity } from '@spinajs/http-socket-example/lib/contract.js';
import { NotesStore } from '@spinajs/http-socket-example/lib/store.js';
import { startNotesServer } from '@spinajs/http-socket-example/lib/server.js';

// Caps blob size and document count, and keeps an edit history per document.
class BoundedNotesStore extends NotesStore {
  public static readonly MAX_BLOB_BYTES = 256 * 1024;
  public static readonly MAX_DOCS = 1_000;

  public readonly history = new Map<string, NoteEntity[]>();

  public doc(docId: string) {
    if (!this.docs.has(docId) && this.docs.size >= BoundedNotesStore.MAX_DOCS) {
      throw new InvalidArgument(`no room for document ${docId}`);
    }
    return super.doc(docId);
  }

  public edit(docId: string, entity: NoteEntity): number {
    const version = super.edit(docId, entity);
    this.history.set(docId, [...(this.history.get(docId) ?? []), entity]);
    return version;
  }

  public putBlob(bytes: Uint8Array): string {
    if (bytes.byteLength > BoundedNotesStore.MAX_BLOB_BYTES) {
      throw new InvalidArgument(`blob of ${bytes.byteLength} bytes is above ${BoundedNotesStore.MAX_BLOB_BYTES}`);
    }
    return super.putBlob(bytes);
  }
}

DI.register(BoundedNotesStore).as(NotesStore);

async function main(): Promise<void> {
  const server = await startNotesServer();
  const store = server.store as BoundedNotesStore;
  store.edit('welcome', { id: 'welcome-0', text: 'Read me first' });
  console.log(store.history.get('welcome')?.length);
  // 1
  await server.close();
}

void main();
```

A thrown `InvalidArgument` reaches the client as `invalid_argument`, like a schema failure.

## Important behaviour

- `doc()` creates a document for any `docId`, so reads create state. A client can fill memory by opening many document ids; the schema caps each id at 64 characters but not their number.
- `edit()` mutates the stored array in place. A running snapshot stream is not affected: it streams a copy.
- `edit()` stores the entity object it receives; a caller that mutates that object later changes the stored note.
- Versions are per document and start at 1; every edit adds 1, even when the text is unchanged.
- Nothing is persisted, and nothing is shared between processes. Two server instances behind a load balancer would hold different documents.

## Best practices

- Keep the store the only owner of document state; controllers call its methods and never keep their own copies.
- Override `doc` to reject unknown ids in a real app, instead of creating them on read.
- Bump the version in every write path; the snapshot resume relies on it to detect changes.

## Related

- [Socket controllers](06-socket-controllers.md): the handlers that call the store.
- [Snapshot stream and resume](07-snapshot-stream.md): how `version` and `chunkCount` drive resume.
- [`@spinajs/di`](../di/README.md): `@Injectable()`, singletons and "last registration wins".
