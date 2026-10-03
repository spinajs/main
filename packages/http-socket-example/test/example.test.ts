import 'mocha';
import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { DEFAULT_STREAM_CREDITS, SocketException, type SocketError } from '@spinajs/http-socket-client';
import { connectNotes, loadSnapshot, toBytes, type NotesClient } from '../src/client.js';
import type { NotesContract, SnapshotFrame } from '../src/contract.js';
import { startNotesServer, type INotesServer } from '../src/server.js';

const FAST_RECONNECT = { minMs: 20, maxMs: 100, jitter: 0 };

function online(notes: NotesClient): Promise<void> {
  if (notes.state === 'online') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const off = notes.on('state', (state) => {
      if (state === 'online') {
        off();
        resolve();
      }
    });
  });
}

/** A network drop: engine.io connections close without a socket.io DISCONNECT. */
function killConnections(server: INotesServer): void {
  for (const socket of server.server.Io?.sockets.sockets.values() ?? []) {
    socket.conn.close();
  }
}

describe('notes example ( server and client end to end )', function () {
  this.timeout(20000);

  let server: INotesServer;
  const clients: NotesClient[] = [];

  const connect = (token: string): NotesClient => {
    const notes = connectNotes(server.url, server.path, token, { reconnect: FAST_RECONNECT });
    clients.push(notes);
    return notes;
  };

  beforeEach(async () => {
    server = await startNotesServer();
  });

  afterEach(async () => {
    clients.splice(0).forEach((notes) => notes.close());
    await server.close();
  });

  it('refuses a handshake without a known token ( auth.required )', async () => {
    const notes = connect('nobody');

    const error = await new Promise<SocketError>((resolve) => notes.on('auth_required', resolve));
    expect(error).to.deep.include({ code: 'unauthenticated', message: 'authentication required' });
  });

  it('opens a document as the signed-in user, and validates the payload', async () => {
    const notes = connect('alice-token');
    await online(notes);

    expect(await notes.command('notes.open', { docId: 'doc-1' })).to.deep.equal({ docId: 'doc-1', version: 1, chunks: 20, openedBy: 'alice' });

    const refused = await notes.command('notes.open', { docId: '' }).then(
      () => null,
      (error: SocketException) => error,
    );
    expect(refused?.code).to.equal('invalid_argument');
  });

  it('streams a whole snapshot with a small credit window', async () => {
    const notes = connect('alice-token');
    await online(notes);

    const snapshot = await loadSnapshot(notes, 'doc-1', { credits: 4 });

    expect(snapshot.version).to.equal(1);
    expect(snapshot.entities.map((e) => e.id)).to.deep.equal(Array.from({ length: 100 }, (_, i) => `doc-1-${i}`));
    expect(snapshot.attempts).to.equal(1);
    expect(server.store.snapshotStarts).to.deep.equal([0]);
  });

  it('reaches the end of a full read with the default credit window, whatever the stream length', async () => {
    const notes = connect('alice-token');
    await online(notes);
    const { chunks } = await notes.command('notes.open', { docId: 'doc-3' });

    // Finding the end costs the server one unit of credit, so lengths at a multiple of the window are the edge;
    // fromChunk k leaves 1 + chunks - k frames: every length from 1 to 21, across 8 and 16.
    expect(chunks + 1).to.be.greaterThan(2 * DEFAULT_STREAM_CREDITS);
    for (let fromChunk = 0; fromChunk <= chunks; fromChunk++) {
      const frames: SnapshotFrame[] = [];
      // the loop leaves only through the stream's end frame; a stall or a fail frame would throw
      for await (const frame of notes.stream('notes.snapshot', { docId: 'doc-3', version: 1, fromChunk })) {
        frames.push(frame);
      }

      expect(frames, `from chunk ${fromChunk}`).to.have.length(1 + chunks - fromChunk);
      expect(frames[frames.length - 1]).to.deep.include(fromChunk === chunks ? { kind: 'begin', from: chunks } : { kind: 'chunk', index: chunks - 1 });
    }

    const snapshot = await loadSnapshot(notes, 'doc-3');
    expect(snapshot.entities).to.have.length(100);
    expect(snapshot.attempts).to.equal(1);
  });

  it('resumes a snapshot from the first missing chunk after the connection drops', async () => {
    const notes = connect('alice-token');
    await online(notes);

    let dropped = false;
    const snapshot = await loadSnapshot(notes, 'doc-1', {
      credits: 2,
      onChunk: (index) => {
        if (index === 5 && !dropped) {
          dropped = true;
          killConnections(server);
        }
      },
    });

    expect(snapshot.entities.map((e) => e.id)).to.deep.equal(Array.from({ length: 100 }, (_, i) => `doc-1-${i}`));
    expect(snapshot.attempts).to.equal(2);
    expect(server.store.snapshotStarts).to.have.length(2);
    expect(server.store.snapshotStarts[0]).to.equal(0);
    // the chunks received before the drop were applied, so the second stream starts after them
    expect(server.store.snapshotStarts[1]).to.be.greaterThan(5);
  });

  it('starts the snapshot over when the document changed while the connection was down', async () => {
    const alice = connect('alice-token');
    const bob = connect('bob-token');
    await Promise.all([online(alice), online(bob)]);
    const edited = { id: 'doc-1-0', text: 'edited while alice was away' };

    let dropped = false;
    const snapshot = await loadSnapshot(alice, 'doc-1', {
      credits: 2,
      onChunk: (index) => {
        if (index === 5 && !dropped) {
          dropped = true;
          // alice stays offline until bob's edit is stored, so her retry always sees version 2
          alice.disconnect();
          void bob.command('notes.edit', { docId: 'doc-1', entity: edited }).then(() => alice.connect());
        }
      },
    });

    expect(snapshot.attempts).to.equal(2);
    expect(snapshot.version).to.equal(2);
    expect(server.store.snapshotStarts).to.deep.equal([0, 0]);
    expect(snapshot.entities).to.have.length(100);
    expect(snapshot.entities[0]).to.deep.equal(edited);
    expect(snapshot.entities.slice(1).map((e) => e.id)).to.deep.equal(Array.from({ length: 99 }, (_, i) => `doc-1-${i + 1}`));
  });

  it('pushes an edit to the clients in the document room', async () => {
    const alice = connect('alice-token');
    const bob = connect('bob-token');
    await Promise.all([online(alice), online(bob)]);
    await alice.command('notes.open', { docId: 'doc-2' });
    await bob.command('notes.open', { docId: 'doc-2' });

    const seen = new Promise<NotesContract['events']['notes.changed']>((resolve) => bob.once('notes.changed', resolve));
    const entity = { id: 'doc-2-0', text: 'changed by alice' };
    const { version } = await alice.command('notes.edit', { docId: 'doc-2', entity });

    expect(await seen).to.deep.equal({ docId: 'doc-2', version, entity, by: 'alice' });
  });

  it('carries binary blobs both ways', async () => {
    const notes = connect('alice-token');
    await online(notes);
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);

    const { hash } = await notes.command('blob.put', { bytes });
    expect(hash).to.equal(createHash('sha256').update(bytes).digest('hex'));

    const back = await notes.command('blob.get', { hash });
    expect(Array.from(toBytes(back))).to.deep.equal([0, 1, 2, 250, 255]);

    const missing = await notes.command('blob.get', { hash: '0'.repeat(64) }).then(
      () => null,
      (error: SocketException) => error,
    );
    expect(missing?.code).to.equal('not_found');
  });
});
