import 'mocha';
import { expect } from 'chai';
import socketConfig from '../src/config/http-socket.js';

describe('stream reply configuration', () => {
  it('ships the stream defaults', () => {
    expect(socketConfig.http.socket.streams).to.deep.equal({ maxCredits: 64, maxPerConnection: 8, stallTimeoutMs: 60_000 });
  });
});
