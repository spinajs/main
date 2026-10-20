import { createHash } from 'node:crypto';
import { Injectable } from '@spinajs/di';
import type { NoteEntity } from './contract.js';

export const ENTITIES_PER_CHUNK = 5;
export const NOTES_PER_DOC = 100;

export interface INoteDoc {
  version: number;
  entities: NoteEntity[];
}

export function chunkCount(entities: readonly NoteEntity[]): number {
  return Math.ceil(entities.length / ENTITIES_PER_CHUNK);
}

/** In memory and in one process: enough to show the protocol, not a storage design. */
@Injectable()
export class NotesStore {
  protected docs = new Map<string, INoteDoc>();
  protected blobs = new Map<string, Uint8Array>();

  /** The first chunk of every snapshot stream the server started, for the resume demo. */
  public readonly snapshotStarts: number[] = [];

  public doc(docId: string): INoteDoc {
    let doc = this.docs.get(docId);
    if (!doc) {
      doc = { version: 1, entities: Array.from({ length: NOTES_PER_DOC }, (_, i) => ({ id: `${docId}-${i}`, text: `note ${i}` })) };
      this.docs.set(docId, doc);
    }
    return doc;
  }

  public edit(docId: string, entity: NoteEntity): number {
    const doc = this.doc(docId);
    const at = doc.entities.findIndex((e) => e.id === entity.id);
    if (at >= 0) {
      doc.entities[at] = entity;
    } else {
      doc.entities.push(entity);
    }
    doc.version++;
    return doc.version;
  }

  public putBlob(bytes: Uint8Array): string {
    const hash = createHash('sha256').update(bytes).digest('hex');
    this.blobs.set(hash, new Uint8Array(bytes));
    return hash;
  }

  public blob(hash: string): Uint8Array | undefined {
    return this.blobs.get(hash);
  }
}
