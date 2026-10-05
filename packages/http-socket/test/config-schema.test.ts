import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import _ from 'lodash';

import socketConfig from '../src/config/http-socket.js';
import { SOCKET_CONFIGURATION_SCHEMA, SocketConfigBootstrapper } from '../src/index.js';
import { bootChild, disposeChildren, violationPaths } from './child-config.js';

const socket = (patch: Record<string, unknown> = {}) => ({ http: { socket: { ..._.cloneDeep(socketConfig.http.socket), ...patch } } });

describe('http.socket configuration schema', () => {
  afterEach(disposeChildren);

  it('accepts the shipped configuration', async () => {
    await bootChild(socket(), SOCKET_CONFIGURATION_SCHEMA);
  });

  it('accepts the bounds: an event cap equal to the burst, a zero revalidation interval, one transport', async () => {
    await bootChild(socket({ rate: { perSecond: 50, burst: 100 }, maxInFlightEventsPerConnection: 100, auth: { required: false, revalidateMs: 0 }, transports: ['polling'] }), SOCKET_CONFIGURATION_SCHEMA);
  });

  describe('a bad value fails the boot with the full path of the bad key', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['a zero rate', { rate: { perSecond: 0, burst: 100 } }, 'http.socket.rate.perSecond'],
      ['a negative rate', { rate: { perSecond: -1, burst: 100 } }, 'http.socket.rate.perSecond'],
      ['a zero burst', { rate: { perSecond: 10, burst: 0 } }, 'http.socket.rate.burst'],
      ['an event cap below the burst', { maxInFlightEventsPerConnection: 99 }, 'http.socket.maxInFlightEventsPerConnection'],
      ['a fractional event cap', { maxInFlightEventsPerConnection: 128.5 }, 'http.socket.maxInFlightEventsPerConnection'],
      ['a zero event cap', { rate: { perSecond: 50, burst: 1 }, maxInFlightEventsPerConnection: 0 }, 'http.socket.maxInFlightEventsPerConnection'],
      ['a fractional payload limit', { maxPayloadBytes: 1.5 }, 'http.socket.maxPayloadBytes'],
      ['a zero payload limit', { maxPayloadBytes: 0 }, 'http.socket.maxPayloadBytes'],
      ['a fractional command cap', { maxInFlightPerConnection: 1.5 }, 'http.socket.maxInFlightPerConnection'],
      ['a zero command cap', { maxInFlightPerConnection: 0 }, 'http.socket.maxInFlightPerConnection'],
      ['a negative revalidation interval', { auth: { required: false, revalidateMs: -1 } }, 'http.socket.auth.revalidateMs'],
      ['an empty transport list', { transports: [] }, 'http.socket.transports'],
      ['an unknown transport', { transports: ['websocket', 'flash'] }, 'http.socket.transports.1'],
      ['a transport list that is not a list', { transports: {} }, 'http.socket.transports'],
      ['a zero connect hook timeout', { hooks: { connectTimeoutMs: 0 } }, 'http.socket.hooks.connectTimeoutMs'],
      ['a zero abort grace', { ordering: { abortGraceMs: 0 } }, 'http.socket.ordering.abortGraceMs'],
      ['a missing hooks block', { hooks: undefined }, 'http.socket.hooks'],
      ['a missing ordering block', { ordering: undefined }, 'http.socket.ordering'],
      ['a missing revalidation interval', { auth: { required: false } }, 'http.socket.auth.revalidateMs'],
    ];

    for (const [label, patch, path] of cases) {
      it(`for ${label}`, async () => {
        expect(await violationPaths(socket(patch), SOCKET_CONFIGURATION_SCHEMA)).to.include(path);
      });
    }
  });

  it('SocketConfigBootstrapper registers the schema', () => {
    new SocketConfigBootstrapper().bootstrap();

    expect(DI.RootContainer.Cache.get('__configurationSchema__', false) ?? []).to.include(SOCKET_CONFIGURATION_SCHEMA);
  });
});
