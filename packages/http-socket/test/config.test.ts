import 'mocha';
import { expect } from 'chai';
import socketConfig from '../src/config/http-socket.js';

describe('http-socket default configuration', () => {
  it('ships the binding defaults of the spec', () => {
    const socket = socketConfig.http.socket;
    expect(socket.path).to.equal('/socket.io');
    expect(socket.maxPayloadBytes).to.equal(1024 * 1024);
    expect(socket.maxInFlightPerConnection).to.equal(32);
    expect(socket.maxInFlightEventsPerConnection).to.equal(128);
    expect(socket.recovery).to.deep.equal({ maxDisconnectionMs: 120_000 });
    expect(socket.idempotency).to.deep.equal({ service: 'MemoryIdempotencyStore', ttlMs: 600_000, maxEntries: 100_000 });
    expect(socket.drainMs).to.equal(5_000);
    expect(socket.hooks).to.deep.equal({ connectTimeoutMs: 10_000 });
  });

  it('ships transport and rate defaults', () => {
    const socket = socketConfig.http.socket;
    expect(socket.pingInterval).to.equal(25_000);
    expect(socket.pingTimeout).to.equal(20_000);
    expect(socket.rate).to.deep.equal({ perSecond: 50, burst: 100 });
    expect(socket.adapter).to.be.undefined;
    expect(socket.transports).to.deep.equal(['websocket', 'polling']);
  });

  it('ships the authz-v3 defaults: no cross-origin handshake, unattended without credentials, revalidation every minute', () => {
    const socket = socketConfig.http.socket;
    expect(socket.cors).to.deep.equal({ origins: [] });
    expect(socket.auth).to.deep.equal({ required: false, revalidateMs: 60_000 });
  });

  it('adds no socket controller directories by default', () => {
    expect(socketConfig.system.dirs.socketControllers).to.deep.equal([]);
  });
});
