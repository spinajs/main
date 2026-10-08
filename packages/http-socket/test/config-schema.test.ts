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

  it('accepts the bounds: an event cap equal to the burst, a zero revalidation interval and drain time, one transport', async () => {
    await bootChild(socket({ rate: { perSecond: 50, burst: 100 }, maxInFlightEventsPerConnection: 100, auth: { required: false, revalidateMs: 0 }, drainMs: 0, transports: ['polling'] }), SOCKET_CONFIGURATION_SCHEMA);
  });

  it('accepts the longest timer delays, a zero recovery window and a required handshake', async () => {
    const longest = 2 ** 31 - 1;
    await bootChild(
      socket({ pingInterval: longest, pingTimeout: longest, hooks: { connectTimeoutMs: longest }, ordering: { abortGraceMs: longest }, recovery: { maxDisconnectionMs: 0 }, auth: { required: true, revalidateMs: 0 } }),
      SOCKET_CONFIGURATION_SCHEMA,
    );
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
      ['an auth switch that is not a boolean', { auth: { required: 'maybe', revalidateMs: 0 } }, 'http.socket.auth.required'],
      ['an empty path', { path: '' }, 'http.socket.path'],
      ['a zero ping interval', { pingInterval: 0 }, 'http.socket.pingInterval'],
      ['a fractional ping timeout', { pingTimeout: 1.5 }, 'http.socket.pingTimeout'],
      ['a negative drain time', { drainMs: -1 }, 'http.socket.drainMs'],
      ['a negative recovery window', { recovery: { maxDisconnectionMs: -1 } }, 'http.socket.recovery.maxDisconnectionMs'],
      ['a repeated transport', { transports: ['websocket', 'websocket'] }, 'http.socket.transports'],
      ['a missing streams block', { streams: undefined }, 'http.socket.streams'],
      ['a zero stream credit window', { streams: { maxCredits: 0, maxPerConnection: 8, stallTimeoutMs: 60_000 } }, 'http.socket.streams.maxCredits'],
      ['a fractional stream cap', { streams: { maxCredits: 64, maxPerConnection: 1.5, stallTimeoutMs: 60_000 } }, 'http.socket.streams.maxPerConnection'],
      ['a stall timeout above the longest timer delay', { streams: { maxCredits: 64, maxPerConnection: 8, stallTimeoutMs: 2 ** 31 } }, 'http.socket.streams.stallTimeoutMs'],
      ['a missing stall timeout', { streams: { maxCredits: 64, maxPerConnection: 8 } }, 'http.socket.streams.stallTimeoutMs'],
      // coerceTypes would read null and false as 0, which turns revalidation or the drain off
      ['a null revalidation interval', { auth: { required: false, revalidateMs: null } }, 'http.socket.auth.revalidateMs'],
      ['a boolean revalidation interval', { auth: { required: false, revalidateMs: false } }, 'http.socket.auth.revalidateMs'],
      ['a null drain time', { drainMs: null }, 'http.socket.drainMs'],
      ['a boolean drain time', { drainMs: false }, 'http.socket.drainMs'],
      ['a missing rate block', { rate: undefined }, 'http.socket.rate'],
      ['a missing payload limit', { maxPayloadBytes: undefined }, 'http.socket.maxPayloadBytes'],
      ['a missing command cap', { maxInFlightPerConnection: undefined }, 'http.socket.maxInFlightPerConnection'],
      ['a missing event cap', { maxInFlightEventsPerConnection: undefined }, 'http.socket.maxInFlightEventsPerConnection'],
      ['a missing auth block', { auth: undefined }, 'http.socket.auth'],
      ['a zero stall timeout', { streams: { maxCredits: 64, maxPerConnection: 8, stallTimeoutMs: 0 } }, 'http.socket.streams.stallTimeoutMs'],
      ['a fractional stall timeout', { streams: { maxCredits: 64, maxPerConnection: 8, stallTimeoutMs: 1.5 } }, 'http.socket.streams.stallTimeoutMs'],
      // and true as 1 ms
      ['a true revalidation interval', { auth: { required: false, revalidateMs: true } }, 'http.socket.auth.revalidateMs'],
      ['a true drain time', { drainMs: true }, 'http.socket.drainMs'],
      ['a true ping interval', { pingInterval: true }, 'http.socket.pingInterval'],
      ['a true ping timeout', { pingTimeout: true }, 'http.socket.pingTimeout'],
      ['a true connect hook timeout', { hooks: { connectTimeoutMs: true } }, 'http.socket.hooks.connectTimeoutMs'],
      ['a true abort grace', { ordering: { abortGraceMs: true } }, 'http.socket.ordering.abortGraceMs'],
      ['a null recovery window', { recovery: { maxDisconnectionMs: null } }, 'http.socket.recovery.maxDisconnectionMs'],
      ['a boolean recovery window', { recovery: { maxDisconnectionMs: false } }, 'http.socket.recovery.maxDisconnectionMs'],
      // setTimeout runs a longer delay after 1 ms
      ['a ping interval above the longest timer delay', { pingInterval: 2 ** 31 }, 'http.socket.pingInterval'],
      ['a ping timeout above the longest timer delay', { pingTimeout: 2 ** 31 }, 'http.socket.pingTimeout'],
      ['a connect hook timeout above the longest timer delay', { hooks: { connectTimeoutMs: 2 ** 31 } }, 'http.socket.hooks.connectTimeoutMs'],
      ['an abort grace above the longest timer delay', { ordering: { abortGraceMs: 2 ** 31 } }, 'http.socket.ordering.abortGraceMs'],
      ['an auth switch given as a string', { auth: { required: 'true', revalidateMs: 0 } }, 'http.socket.auth.required'],
      ['an auth switch given as a number', { auth: { required: 1, revalidateMs: 0 } }, 'http.socket.auth.required'],
    ];

    for (const [label, patch, path] of cases) {
      it(`for ${label}`, async () => {
        expect(await violationPaths(socket(patch), SOCKET_CONFIGURATION_SCHEMA)).to.include(path);
      });
    }
  });

  describe('SocketConfigBootstrapper', () => {
    const schemas = (): unknown[] => (DI.get(Array.ofType('__configurationSchema__' as never)) as unknown[] | null) ?? [];
    let saved: unknown[] = [];

    beforeEach(() => {
      saved = [...schemas()];
    });

    afterEach(() => {
      DI.uncache('__configurationSchema__' as never);
      for (const other of saved) DI.register(other as never).asValue('__configurationSchema__');
    });

    it('registers the schema in the root container', () => {
      new SocketConfigBootstrapper().bootstrap();

      expect(schemas()).to.include(SOCKET_CONFIGURATION_SCHEMA);
    });
  });
});
