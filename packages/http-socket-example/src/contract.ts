import { defineContract } from '@spinajs/http-socket-common';

export interface NoteEntity {
  id: string;
  text: string;
}

/** The frames of `notes.snapshot`: a `begin`, then the chunks from `from` on. The stream's own `end` closes it. */
export type SnapshotFrame = { kind: 'begin'; docId: string; version: number; chunks: number; from: number } | { kind: 'chunk'; index: number; entities: NoteEntity[] };

/** Binary arrives as a Buffer ( a Uint8Array ) in Node and as an ArrayBuffer in browsers. */
export type Bytes = ArrayBuffer | Uint8Array;

/** Shared by the server and the client; `type`, not `interface`, so it fits ContractShape. */
export type NotesContract = {
  commands: {
    'notes.open': [{ docId: string }, { docId: string; version: number; chunks: number; openedBy: string }];
    'notes.snapshot': [{ docId: string; version?: number; fromChunk?: number }, AsyncIterable<SnapshotFrame>];
    'notes.edit': [{ docId: string; entity: NoteEntity }, { version: number }];
    'blob.put': [{ bytes: Bytes }, { hash: string }];
    'blob.get': [{ hash: string }, Bytes];
  };
  events: {
    'notes.changed': { docId: string; version: number; entity: NoteEntity; by: string };
  };
  clientEvents: Record<string, never>;
};

export const notesContract = defineContract<NotesContract>();
