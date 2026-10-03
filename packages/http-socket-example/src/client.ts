import { SocketClient, SocketException, type SocketClientOptions, type TypedSocketClient } from '@spinajs/http-socket-client';
import { notesContract, type Bytes, type NoteEntity, type NotesContract } from './contract.js';

export type NotesClient = TypedSocketClient<NotesContract>;

/** A typed client signed in with a demo token. In a real app `clientId` is stable per install. */
export function connectNotes(url: string, path: string, token: string, options: Partial<SocketClientOptions> = {}): NotesClient {
  const client = new SocketClient({
    url,
    path,
    clientId: `notes-${token}`,
    auth: () => ({ token }),
    io: { transports: ['websocket'] },
    ...options,
  });

  return client.typed(notesContract);
}

/** Binary results arrive as a Buffer in Node and as an ArrayBuffer in browsers. */
export function toBytes(data: Bytes): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export interface ISnapshot {
  version: number;
  entities: NoteEntity[];
  /** stream calls it took; 1 without a drop */
  attempts: number;
}

export interface ILoadSnapshotOptions {
  credits?: number;
  maxAttempts?: number;
  /** after each applied chunk */
  onChunk?: (index: number) => void;
}

/**
 * Reads a whole snapshot. After a retryable failure ( a dropped connection ) it waits until the client
 * is online again and resumes from the first chunk it has not applied, unless the document changed.
 */
export async function loadSnapshot(notes: NotesClient, docId: string, options: ILoadSnapshotOptions = {}): Promise<ISnapshot> {
  const maxAttempts = options.maxAttempts ?? 5;
  let entities: NoteEntity[] = [];
  let version: number | undefined;
  let next = 0;

  for (let attempt = 1; ; attempt++) {
    try {
      const frames = notes.stream('notes.snapshot', { docId, version, fromChunk: next }, { credits: options.credits, whenOffline: 'wait' });

      for await (const frame of frames) {
        if (frame.kind === 'begin') {
          // the server could not resume and starts over at chunk 0
          if (frame.from !== next) {
            entities = [];
            next = frame.from;
          }
          version = frame.version;
          continue;
        }

        if (frame.index !== next) {
          throw new SocketException('internal', `chunk ${frame.index} arrived, expected ${next}`);
        }
        entities = entities.concat(frame.entities);
        next++;
        options.onChunk?.(frame.index);
      }

      return { version: version ?? 0, entities, attempts: attempt };
    } catch (error) {
      if (!(error instanceof SocketException) || !error.retryable || attempt >= maxAttempts) {
        throw error;
      }
    }
  }
}
