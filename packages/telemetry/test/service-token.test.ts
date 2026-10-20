import 'mocha';
import { expect } from 'chai';
import _ from 'lodash';
import { GLOBAL } from '@spinajs/authz';
import { ConfigRoleStore, assignmentProblem, compileRoles } from '@spinajs/authz-rbac';
import type { Configuration } from '@spinajs/configuration';
import { testHost } from '@spinajs/authz-testing';

import fragment from '../src/config/telemetry.js';
import { bridgeTelemetryToken } from '../src/index.js';
import { TEST_TOKEN } from './common.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { registerHeaderSource } from './support/principals.js';

const GUARDED = ['metrics', 'stats', 'timeline', 'routes', 'perf'] as const;
const PROBES = ['health', 'ready'] as const;
const path = (endpoint: string) => (endpoint === 'metrics' ? '/metrics' : `/telemetry/${endpoint}`);

function memoryConfig(data: Record<string, unknown>) {
  return {
    data,
    get: <T>(p: string | string[], fallback?: T): T => _.get(data, p, fallback) as T,
    set: (p: string | string[], value: unknown) => void _.set(data, p, value),
  };
}

function recordingLog() {
  const lines: string[] = [];
  return { lines, info: (message: string) => void lines.push(message) };
}

describe('telemetry config fragment', () => {
  it('guards the data endpoints with AccessPolicy and telemetry:read, and leaves the probes public', () => {
    for (const endpoint of GUARDED) {
      expect(fragment.telemetry.auth.policies[endpoint], endpoint).to.eq('AccessPolicy');
      expect(fragment.telemetry.auth.permissions[endpoint], endpoint).to.eq('telemetry:read');
    }
    for (const endpoint of PROBES) {
      expect(fragment.telemetry.auth.policies[endpoint], endpoint).to.eq('PublicPolicy');
      expect(fragment.telemetry.auth.permissions, endpoint).to.not.have.property(endpoint);
    }
    expect(fragment.telemetry.auth.token).to.eq('');
    expect(fragment.telemetry.auth.domain).to.eq('root');
  });

  it('registers telemetry:read and grants it to service:telemetry through the telemetry role', () => {
    expect(fragment.authz.permissions['telemetry:read'].description).to.be.a('string').and.not.empty;
    expect(fragment.authz.rbac.roles.telemetry.grants).to.deep.eq(['telemetry:read']);
    expect(fragment.authz.rbac.serviceRoles).to.deep.eq({ 'service:telemetry': ['telemetry'] });
  });

  it('defines a telemetry role RBAC can assign at GLOBAL, as serviceRoles needs', async () => {
    const config = memoryConfig(structuredClone({ authz: fragment.authz }));
    const { roles, ladders } = await new ConfigRoleStore(config as unknown as Configuration).load();
    expect(assignmentProblem(compileRoles(roles, ladders), 'telemetry', GLOBAL)).to.eq(undefined);
  });
});

describe('bridgeTelemetryToken', () => {
  const services = (config: ReturnType<typeof memoryConfig>) => config.get<unknown[]>(['authz', 'http', 'services']);

  it('adds service:telemetry on x-metrics-token and on Authorization: Bearer', () => {
    const other = { name: 'billing', header: 'x-billing', token: 'b' };
    const config = memoryConfig({ telemetry: { auth: { token: 'secret' } }, authz: { http: { services: [other] } } });
    bridgeTelemetryToken(config);
    expect(services(config)).to.deep.eq([other, { name: 'telemetry', header: 'x-metrics-token', token: 'secret' }, { name: 'telemetry', header: 'authorization', token: 'Bearer secret' }]);
  });

  it('creates authz.http.services when it is missing', () => {
    const config = memoryConfig({ telemetry: { auth: { token: 'secret' } } });
    bridgeTelemetryToken(config);
    expect(services(config)).to.have.length(2);
  });

  it('adds nothing for an empty, missing or non-string token', () => {
    for (const token of ['', undefined, 42, ['secret']]) {
      const config = memoryConfig({ telemetry: { auth: { token } }, authz: { http: { services: [] } } });
      bridgeTelemetryToken(config);
      expect(services(config), JSON.stringify(token)).to.deep.eq([]);
    }
  });

  it('adds no duplicates when it runs again', () => {
    const log = recordingLog();
    const config = memoryConfig({ telemetry: { auth: { token: 'secret' } } });
    bridgeTelemetryToken(config, log);
    bridgeTelemetryToken(config, log);
    expect(services(config)).to.have.length(2);
    expect(log.lines).to.deep.eq([]);
  });

  it('leaves an explicit telemetry entry alone and says once that the token key is ignored, without the token', () => {
    const log = recordingLog();
    const explicit = { name: 'telemetry', header: 'x-scrape', token: 'other' };
    const config = memoryConfig({ telemetry: { auth: { token: 'secret' } }, authz: { http: { services: [explicit] } } });
    bridgeTelemetryToken(config, log);
    expect(services(config)).to.deep.eq([explicit]);
    expect(log.lines).to.have.length(1);
    expect(log.lines[0]).to.contain('telemetry.auth.token');
    expect(log.lines[0]).to.not.contain('secret');
  });

  it('leaves a malformed authz.http.services for authz-http to report', () => {
    const config = memoryConfig({ telemetry: { auth: { token: 'secret' } }, authz: { http: { services: 'nope' } } });
    bridgeTelemetryToken(config);
    expect(services(config)).to.eq('nope');
  });
});

describe('telemetry endpoints on authz', function () {
  this.timeout(30000);

  const sameLength = 'x'.repeat(TEST_TOKEN.length);

  describe('with the RBAC model and the fragment config', () => {
    let app: TestApp;
    let unregisterSource: () => void;

    before(async () => {
      unregisterSource = registerHeaderSource();
      app = await startApp({ rbac: true });
    });

    after(async () => {
      await stopApp();
      unregisterSource?.();
    });

    const get = (endpoint: string, headers: Record<string, string> = {}) => {
      let r = app.request().get(path(endpoint)).set('Accept', 'application/json');
      for (const [name, value] of Object.entries(headers)) r = r.set(name, value);
      return r;
    };

    it('answers 401 without credentials', async () => {
      for (const endpoint of GUARDED) {
        const res = await get(endpoint);
        expect(res.status, endpoint).to.eq(401);
        expect(res.body, endpoint).to.deep.include({ error: 'unauthenticated' });
      }
    });

    it('answers 401 for a wrong token of the same length or another length, on either header', async () => {
      for (const wrong of [sameLength, 'nope', `${TEST_TOKEN}-and-more`]) {
        for (const headers of [{ 'x-metrics-token': wrong }, { authorization: `Bearer ${wrong}` }] as Record<string, string>[]) {
          const res = await get('stats', headers);
          expect(res.status, JSON.stringify(headers)).to.eq(401);
        }
      }
    });

    it('answers 200 for the token on x-metrics-token', async () => {
      for (const endpoint of GUARDED) {
        expect((await get(endpoint, { 'x-metrics-token': TEST_TOKEN })).status, endpoint).to.eq(200);
      }
    });

    it('answers 200 for the token as Authorization: Bearer', async () => {
      for (const endpoint of GUARDED) {
        expect((await get(endpoint, { authorization: `Bearer ${TEST_TOKEN}` })).status, endpoint).to.eq(200);
      }
    });

    it('answers 403 naming telemetry:read to a principal without the permission', async () => {
      const res = await get('stats', { 'x-user': 'alice' });
      expect(res.status).to.eq(403);
      expect(res.body).to.deep.include({ error: 'forbidden', permission: 'telemetry:read' });
    });

    it('leaves the probes open without credentials', async () => {
      expect((await get('health')).status).to.eq(200);
      // A stub check another suite registered may still be down: 503 is an answer, not a refusal.
      expect([200, 503]).to.include((await get('ready')).status);
    });
  });

  describe('with an explicit telemetry entry in authz.http.services', () => {
    let app: TestApp;

    before(async () => {
      app = await startApp({ rbac: true, config: { 'authz.http.services': [{ name: 'telemetry', header: 'x-scrape', token: 'scrape-token-456' }] } });
    });

    after(async () => {
      await stopApp();
    });

    it('authenticates the explicit entry and ignores telemetry.auth.token', async () => {
      const get = (name: string, value: string) => app.request().get('/telemetry/stats').set('Accept', 'application/json').set(name, value);
      expect((await get('x-scrape', 'scrape-token-456')).status).to.eq(200);
      expect((await get('x-metrics-token', TEST_TOKEN)).status).to.eq(401);
      expect((await get('authorization', `Bearer ${TEST_TOKEN}`)).status).to.eq(401);
    });
  });

  describe('with an empty telemetry.auth.token', () => {
    before(async () => {
      await startApp({ rbac: true, config: { 'telemetry.auth.token': '' } });
    });

    after(async () => {
      await stopApp();
    });

    it('adds no telemetry service', () => {
      const services = testHost.config().get<{ name: string }[]>(['authz', 'http', 'services']) ?? [];
      expect(services.filter((s) => s.name === 'telemetry')).to.deep.eq([]);
    });
  });

  describe('without authz-rbac', () => {
    let app: TestApp;

    before(async () => {
      app = await startApp();
    });

    after(async () => {
      await stopApp();
    });

    it('boots with the fragment config: the probes answer and no model grants the token', async () => {
      expect((await app.request().get('/telemetry/health').set('Accept', 'application/json')).status).to.eq(200);
      const res = await app.request().get('/telemetry/stats').set('Accept', 'application/json').set('x-metrics-token', TEST_TOKEN);
      expect(res.status).to.eq(403);
      expect(res.body).to.deep.include({ error: 'forbidden', permission: 'telemetry:read' });
    });
  });
});
