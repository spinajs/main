import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';

import { HttpConfigBootstrapper } from '../src/bootstrap.js';
import { HTTP_CONFIGURATION_SCHEMA } from '../src/schemas/http.configuration.js';
import { boot, disposeBooted, violationsOf } from './support/config-boot.js';

const SCHEMAS = [HTTP_CONFIGURATION_SCHEMA];
const bad = (http: Record<string, unknown>) => violationsOf(SCHEMAS, { http });

describe('http configuration schema', () => {
  afterEach(disposeBooted);

  describe('defaults', () => {
    it('gives an unconfigured http module no trusted proxy and a disabled throttle', async () => {
      const { configuration } = await boot(SCHEMAS, {});
      expect(configuration.get('http.trustProxy')).to.eq(null);
      expect(configuration.get('http.throttle')).to.deep.eq({ enabled: false, rules: [] });
    });

    it('keeps a configured throttle and fills the rest', async () => {
      const { configuration } = await boot(SCHEMAS, { http: { throttle: { rules: [{ path: '/auth', limit: 5, windowSeconds: 60 }] } } });
      expect(configuration.get('http.throttle.enabled')).to.eq(false);
      expect(configuration.get('http.throttle.rules')).to.deep.eq([{ path: '/auth', limit: 5, windowSeconds: 60 }]);
    });
  });

  describe('trustProxy', () => {
    it('accepts a hop count, 0, a list and a comma-separated string unchanged', async () => {
      for (const value of [0, 2, ['10.0.0.0/8', 'loopback'], '10.0.0.1, 10.0.0.2', null]) {
        const { configuration } = await boot(SCHEMAS, { http: { trustProxy: value } });
        expect(configuration.get('http.trustProxy'), JSON.stringify(value)).to.deep.eq(value);
      }
    });

    it('turns true into one hop, never trust-all', async () => {
      const { configuration } = await boot(SCHEMAS, { http: { trustProxy: true } });
      expect(configuration.get('http.trustProxy')).to.eq(1);
    });

    it('names http.trustProxy for a negative count, a fraction and an object', async () => {
      for (const value of [-1, 1.5, {}]) expect(await bad({ trustProxy: value }), JSON.stringify(value)).to.include('http.trustProxy');
    });
  });

  describe('cookie.secret', () => {
    it('refuses an empty secret and a null one (coerced to empty)', async () => {
      expect(await bad({ cookie: { secret: '' } })).to.include('http.cookie.secret');
      expect(await bad({ cookie: { secret: null } })).to.include('http.cookie.secret');
    });

    it('accepts a secret', async () => {
      expect(await bad({ cookie: { secret: 'k'.repeat(40) } })).to.deep.eq([]);
    });
  });

  describe('cors', () => {
    it('accepts no CORS, listed origins and the wildcard', async () => {
      for (const cors of [false, null, {}, { origins: [] }, { origins: null }, { origins: ['*', 'https://app.example.com:8443'] }, { origins: ['https://app.example.com/'], exposedHeaders: ['x-a'], allowedHeaders: 'x-b, x-c' }]) {
        expect(await bad({ cors }), JSON.stringify(cors)).to.deep.eq([]);
      }
    });

    it('names the bad origin entry', async () => {
      const entries = ['partner.example.org', 'https://partner.example.org/app', 'https://*.example.org', 'https://user@partner.example.org', 'null', ''];
      for (const entry of entries) expect(await bad({ cors: { origins: ['https://ok.example.com', entry] } }), JSON.stringify(entry)).to.include('http.cors.origins.1');
      expect(await bad({ cors: { origins: 'https://ok.example.com' } })).to.include('http.cors.origins');
    });
  });

  describe('throttle', () => {
    it('names the bad rule field', async () => {
      expect(await bad({ throttle: { rules: [{ path: '/a', limit: 0, windowSeconds: 60 }] } })).to.include('http.throttle.rules.0.limit');
      expect(await bad({ throttle: { rules: [{ path: '/a', limit: 5, windowSeconds: 1.5 }] } })).to.include('http.throttle.rules.0.windowSeconds');
      expect(await bad({ throttle: { rules: [{ path: '', limit: 5, windowSeconds: 60 }] } })).to.include('http.throttle.rules.0.path');
      expect(await bad({ throttle: { rules: [{ limit: 5, windowSeconds: 60 }] } })).to.include('http.throttle.rules.0.path');
      expect(await bad({ throttle: { enabled: 'maybe' } })).to.include('http.throttle.enabled');
    });
  });

  describe('socket', () => {
    const sound = { rate: { perSecond: 20, burst: 40 }, maxPayloadBytes: 1024, maxInFlightPerConnection: 32, maxInFlightEventsPerConnection: 128, auth: { required: false, revalidateMs: 0 }, transports: ['websocket'] };

    it('accepts the shipped shape', async () => {
      expect(await bad({ socket: sound })).to.deep.eq([]);
    });

    it('names the key of every range the limits check used to throw RangeError for', async () => {
      expect(await bad({ socket: { ...sound, rate: { perSecond: 0, burst: 40 } } })).to.include('http.socket.rate.perSecond');
      expect(await bad({ socket: { ...sound, maxPayloadBytes: 0 } })).to.include('http.socket.maxPayloadBytes');
      expect(await bad({ socket: { ...sound, maxInFlightPerConnection: 1.5 } })).to.include('http.socket.maxInFlightPerConnection');
      expect(await bad({ socket: { ...sound, auth: { revalidateMs: -1 } } })).to.include('http.socket.auth.revalidateMs');
      expect(await bad({ socket: { ...sound, transports: ['websocket', 'tcp'] } })).to.include('http.socket.transports.1');
      expect(await bad({ socket: { ...sound, transports: [] } })).to.include('http.socket.transports');
    });

    it('requires the event cap to be at least the burst ($data)', async () => {
      expect(await bad({ socket: { ...sound, rate: { perSecond: 1, burst: 200 } } })).to.include('http.socket.maxInFlightEventsPerConnection');
      expect(await bad({ socket: { ...sound, rate: { perSecond: 1, burst: 128 } } })).to.deep.eq([]);
    });
  });

  it('reports every violation, not the first', async () => {
    const found = await bad({ trustProxy: -1, cors: { origins: ['nope'] }, throttle: { rules: [{ path: '/a', limit: 0, windowSeconds: 60 }] } });
    expect(found).to.include.members(['http.trustProxy', 'http.cors.origins.0', 'http.throttle.rules.0.limit']);
  });
});

describe('HttpConfigBootstrapper', () => {
  const schemas = (): unknown[] => (DI.get(Array.ofType('__configurationSchema__' as never)) as unknown[] | null) ?? [];
  let saved: unknown[] = [];

  beforeEach(() => {
    saved = [...schemas()];
  });

  afterEach(() => {
    DI.uncache('__configurationSchema__' as never);
    for (const other of saved) DI.register(other as never).asValue('__configurationSchema__');
  });

  it('registers the http schema under __configurationSchema__', () => {
    new HttpConfigBootstrapper().bootstrap();
    expect(schemas()).to.include(HTTP_CONFIGURATION_SCHEMA);
  });
});
