import 'mocha';
import { expect } from 'chai';
import socketConfig from '../src/config/http-socket.js';
import { assertStreamsConfig } from '../src/limits.js';
import { startServer } from './harness.js';

describe('stream reply configuration', function () {
  this.timeout(15000);

  const ok = { streams: { maxCredits: 64, maxPerConnection: 8, stallTimeoutMs: 60_000 } };

  it('ships the stream defaults', () => {
    expect(socketConfig.http.socket.streams).to.deep.equal(ok.streams);
  });

  it('accepts the defaults', () => {
    expect(() => assertStreamsConfig(ok)).not.to.throw();
  });

  it('refuses a missing block and values that are not integers above 0', () => {
    expect(() => assertStreamsConfig({} as typeof ok)).to.throw(RangeError);

    for (const key of ['maxCredits', 'maxPerConnection', 'stallTimeoutMs'] as const) {
      for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '8', undefined]) {
        expect(() => assertStreamsConfig({ streams: { ...ok.streams, [key]: bad } } as typeof ok), `${key} ${String(bad)}`).to.throw(RangeError);
      }
    }
  });

  it('refuses a stall timeout above the longest timer delay', () => {
    expect(() => assertStreamsConfig({ streams: { ...ok.streams, stallTimeoutMs: 2 ** 31 } })).to.throw(RangeError);
  });

  it('refuses to start the server with a bad streams block', async () => {
    await expect(startServer({ http: { socket: { streams: { maxCredits: 0 } } } })).to.be.rejectedWith(RangeError, /streams\.maxCredits/);
  });
});
