import 'mocha';
import { expect } from 'chai';
import * as api from '../src/index.js';

describe('public entry', () => {
  it('exports the client surface and the common protocol', () => {
    for (const name of ['SocketClient', 'LIFECYCLE_EVENTS', 'ReconnectPolicy', 'DEFAULT_RECONNECT', 'DEFAULT_TIMEOUT_MS', 'DEFAULT_CONNECT_TIMEOUT_MS', 'SocketException', 'isSocketError', 'WIRE_EVENTS', 'SYSTEM_EVENTS', 'defineContract', 'PROTOCOL_VERSION']) {
      expect(api, name).to.have.property(name);
    }
  });

  it('keeps the internals private', () => {
    for (const name of ['Connection', 'CommandDispatcher', 'Emitter', 'randomId']) {
      expect(api, name).to.not.have.property(name);
    }
  });

  it('ships the binding defaults', () => {
    expect(api.DEFAULT_RECONNECT).to.deep.equal({ minMs: 500, maxMs: 30_000, jitter: 0.3 });
    expect(api.DEFAULT_TIMEOUT_MS).to.equal(15_000);
  });
});
