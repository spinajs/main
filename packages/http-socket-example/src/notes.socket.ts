import { Autoinject } from '@spinajs/di';
import { InvalidArgument, ResourceNotFound } from '@spinajs/exceptions';
import { BaseSocketController, Command, Connection, Payload, Signal, SocketConnection, SocketController, SocketHub } from '@spinajs/http-socket';
import type { NotesContract, SnapshotFrame } from './contract.js';
import type { DemoUser } from './auth.js';
import { ENTITIES_PER_CHUNK, NotesStore, chunkCount } from './store.js';

/** The payload type of a contract command. */
type In<N extends keyof NotesContract['commands']> = NotesContract['commands'][N][0];
type NotesConnection = SocketConnection<Record<string, unknown>, DemoUser>;

const DOC_ID = { type: 'string', minLength: 1, maxLength: 64 };
const OpenSchema = { type: 'object', required: ['docId'], properties: { docId: DOC_ID }, additionalProperties: false };
const SnapshotSchema = { type: 'object', required: ['docId'], properties: { docId: DOC_ID, version: { type: 'integer', minimum: 1 }, fromChunk: { type: 'integer', minimum: 0 } }, additionalProperties: false };
const EditSchema = {
  type: 'object',
  required: ['docId', 'entity'],
  properties: {
    docId: DOC_ID,
    entity: { type: 'object', required: ['id', 'text'], properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, text: { type: 'string', maxLength: 10_000 } }, additionalProperties: false },
  },
  additionalProperties: false,
};
const HashSchema = { type: 'object', required: ['hash'], properties: { hash: { type: 'string', pattern: '^[0-9a-f]{64}$' } }, additionalProperties: false };

@SocketController('notes')
export class NotesSocket extends BaseSocketController {
  @Autoinject()
  protected Store: NotesStore;

  @Autoinject()
  protected Hub: SocketHub;

  /** Joins the document's room, so the connection receives `notes.changed`. */
  @Command('open', { schema: OpenSchema })
  public async open(@Payload() req: In<'notes.open'>, @Connection() conn: NotesConnection) {
    const doc = this.Store.doc(req.docId);
    conn.join(`doc:${req.docId}`);
    return { docId: req.docId, version: doc.version, chunks: chunkCount(doc.entities), openedBy: conn.user?.name ?? 'nobody' };
  }

  /**
   * A stream reply. It resumes at `fromChunk` while the document is still at `version`, and starts
   * over at chunk 0 otherwise; `begin.from` tells the client which.
   */
  @Command('snapshot', { schema: SnapshotSchema })
  public async *snapshot(@Payload() req: In<'notes.snapshot'>, @Signal() signal: AbortSignal): AsyncGenerator<SnapshotFrame> {
    const doc = this.Store.doc(req.docId);
    const version = doc.version;
    // a copy: edits made while the snapshot streams must not shift its chunks
    const entities = [...doc.entities];
    const chunks = chunkCount(entities);
    const from = req.version === version && req.fromChunk !== undefined ? Math.min(req.fromChunk, chunks) : 0;
    this.Store.snapshotStarts.push(from);

    yield { kind: 'begin', docId: req.docId, version, chunks, from };

    for (let index = from; index < chunks && !signal.aborted; index++) {
      yield { kind: 'chunk', index, entities: entities.slice(index * ENTITIES_PER_CHUNK, (index + 1) * ENTITIES_PER_CHUNK) };
    }
  }

  @Command('edit', { schema: EditSchema })
  public async edit(@Payload() req: In<'notes.edit'>, @Connection() conn: NotesConnection) {
    const version = this.Store.edit(req.docId, req.entity);
    const changed: NotesContract['events']['notes.changed'] = { docId: req.docId, version, entity: req.entity, by: conn.user?.name ?? 'nobody' };
    this.Hub.to(`doc:${req.docId}`).emit('notes.changed', changed);
    return { version };
  }
}

@SocketController('blob')
export class BlobSocket extends BaseSocketController {
  @Autoinject()
  protected Store: NotesStore;

  /** Binary payload parts arrive as a Buffer, which is a Uint8Array. */
  @Command('put')
  public async put(@Payload() req: In<'blob.put'>) {
    if (!(req?.bytes instanceof Uint8Array)) {
      throw new InvalidArgument('bytes must be binary');
    }
    return { hash: this.Store.putBlob(req.bytes) };
  }

  @Command('get', { schema: HashSchema })
  public async get(@Payload() req: In<'blob.get'>) {
    const blob = this.Store.blob(req.hash);
    if (!blob) {
      throw new ResourceNotFound(`no blob ${req.hash}`);
    }
    return blob;
  }
}
