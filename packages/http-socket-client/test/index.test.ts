import 'mocha';
import { expect } from 'chai';
import * as api from '../src/index.js';
import type { ClientLifecycleEvents, StreamItem, StreamOptions, TypedSocketClient } from '../src/index.js';

describe('public entry', () => {
  it('exports the client surface and the common protocol', () => {
    for (const name of ['SocketClient', 'LIFECYCLE_EVENTS', 'ReconnectPolicy', 'DEFAULT_RECONNECT', 'DEFAULT_TIMEOUT_MS', 'DEFAULT_CONNECT_TIMEOUT_MS', 'DEFAULT_STREAM_CREDITS', 'MAX_SERVER_HINT_MS', 'SocketException', 'isSocketError', 'isChunk', 'WIRE_EVENTS', 'SYSTEM_EVENTS', 'defineContract', 'PROTOCOL_VERSION', 'MemoryOutboxStore', 'DEFAULT_DURABLE']) {
      expect(api, name).to.have.property(name);
    }
  });

  it('keeps the internals private', () => {
    for (const name of ['Connection', 'CommandDispatcher', 'Emitter', 'randomId', 'DurableQueue', 'StreamDispatcher', 'ClientStream']) {
      expect(api, name).to.not.have.property(name);
    }
  });

  it('ships the binding defaults', () => {
    expect(api.DEFAULT_RECONNECT).to.deep.equal({ minMs: 500, maxMs: 30_000, jitter: 0.3 });
    expect(api.DEFAULT_TIMEOUT_MS).to.equal(15_000);
    expect(api.DEFAULT_STREAM_CREDITS).to.equal(8);
  });
});

// Compile-time only: the entry point must export the contract types; `npm run typecheck` checks it.
type IndexContract = {
  commands: { 'n.list': [{ q: string }, AsyncIterable<number>] };
  events: { 'n.changed': { id: string } };
  clientEvents: Record<string, never>;
};

function indexTypeChecks(api: TypedSocketClient<IndexContract>, lifecycle: ClientLifecycleEvents): void {
  const item: StreamItem<IndexContract, 'n.list'> = 1;
  const items: AsyncIterable<number> = api.stream('n.list', { q: 'x' });
  const iterator: AsyncIterableIterator<number> = api.stream('n.list', { q: 'x' }, { credits: 4, timeoutMs: 1000 });
  const options: StreamOptions = { credits: 16, whenOffline: 'wait' };
  void [iterator, options];
  api.on('refused', (error) => {
    const code: string = error.code;
    void code;
  });
  void [item, items, lifecycle.refused];
}
void indexTypeChecks;
