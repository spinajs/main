import 'mocha';
import { expect } from 'chai';
import { Configuration } from '@spinajs/configuration';
import type { ControllerEntry, RouteEntry } from '@spinajs/manifest';
import { createTestApp, disposeTestApps, manifestContractValidator, sourceRef, stripExtensions, testManifest } from '../src/index.js';
import { CONTRACT_VALIDATOR_KEY, CONTRACT_VIOLATIONS_KEY } from '../src/index.js';
import { DI } from '@spinajs/di';

const route = (handler: string, schema?: string): RouteEntry => ({
  method: 'get',
  path: handler,
  handler,
  fullPath: `/${handler}`,
  params: [],
  returnType: { text: 'T', ...(schema ? { schema } : {}) },
  policies: [],
  middlewares: [],
  source: sourceRef('a.ts'),
});

const controller = (routes: RouteEntry[]): ControllerEntry => ({ id: 'test-app:A', className: 'A', basePath: null, policies: [], middlewares: [], routes, source: sourceRef('a.ts') });

const USER = {
  $id: 'spinajs/test/User',
  type: 'object',
  properties: { id: { type: 'number' }, email: { type: 'string' }, 'x-field': { type: 'string' } },
  required: ['id', 'email'],
  additionalProperties: false,
  'x-derived': true,
};

function validator(extra: Record<string, unknown> = {}) {
  return manifestContractValidator(
    testManifest({
      controllers: [controller([route('get', 'spinajs/test/User'), route('list', 'spinajs/test/Users'), route('partial', 'spinajs/test/Partial'), route('bare')])],
      schemas: {
        'spinajs/test/User': USER,
        'spinajs/test/Users': { $id: 'spinajs/test/Users', type: 'array', items: { $ref: 'spinajs/test/User' }, 'x-derived': true },
        'spinajs/test/Partial': { $id: 'spinajs/test/Partial', type: 'object', properties: { id: { type: 'string' } }, required: ['id'], 'x-explicit': 'partial' },
        ...extra,
      },
    }),
  );
}

describe('manifestContractValidator', () => {
  it('accepts a body that matches the derived schema, with x-* keywords stripped', () => {
    expect(validator().checkResponse({ controller: 'A', handler: 'get' }, { id: 1, email: 'a@b', 'x-field': 'kept as data' })).to.equal(null);
  });

  it('reports a missing required property and a wrong type', () => {
    const errors = validator().checkResponse({ controller: 'A', handler: 'get' }, { id: '1' });
    expect(errors?.map((e) => (e as { keyword: string }).keyword).sort()).to.deep.equal(['required', 'type']);
  });

  it('resolves a relative $ref between manifest schemas', () => {
    const v = validator();
    expect(v.checkResponse({ controller: 'A', handler: 'list' }, [{ id: 1, email: 'a' }])).to.equal(null);
    expect(v.checkResponse({ controller: 'A', handler: 'list' }, [{ id: 1 }])).to.have.length.greaterThan(0);
  });

  it('does not fail a partial explicit schema', () => {
    expect(validator().checkResponse({ controller: 'A', handler: 'partial' }, { id: 5, anything: true })).to.equal(null);
  });

  it('leaves a route without a schema, an unknown route and an unknown controller unchecked', () => {
    const v = validator();
    expect(v.checkResponse({ controller: 'A', handler: 'bare' }, 'x')).to.equal(null);
    expect(v.checkResponse({ controller: 'A', handler: 'nope' }, 'x')).to.equal(null);
    expect(v.checkResponse({ controller: 'Z', handler: 'get' }, 'x')).to.equal(null);
  });

  it('reports a route schema that the manifest does not hold', () => {
    const v = manifestContractValidator(testManifest({ controllers: [controller([route('get', 'spinajs/test/Gone')])] }));
    expect(v.checkResponse({ controller: 'A', handler: 'get' }, {})).to.have.length(1);
  });

  it('checks a body against a given schema', () => {
    const v = validator();
    const problem = { $id: 'spinajs/test/Problem', type: 'object', required: ['title'], properties: { title: { type: 'string' } } };
    expect(v.checkSchema(problem, { title: 't' })).to.equal(null);
    expect(v.checkSchema(problem, {})).to.have.length(1);
  });
});

describe('stripExtensions', () => {
  it('drops x-* keywords but keeps a property named like one', () => {
    expect(stripExtensions({ 'x-derived': true, properties: { 'x-a': { type: 'string', 'x-b': 1 } } })).to.deep.equal({ properties: { 'x-a': { type: 'string' } } });
  });
});

describe('createTestApp contractTesting', () => {
  afterEach(disposeTestApps);

  const manifest = () => testManifest({ controllers: [controller([route('get', 'spinajs/test/User')])], schemas: { 'spinajs/test/User': USER } });

  it('registers the validator and violation log and switches the http setting on', async () => {
    const app = await createTestApp({ bootstrap: false, config: {}, contractTesting: { manifest: manifest(), mode: 'log' } });
    expect(app.config.get('http.contractTesting')).to.deep.equal({ enabled: true, mode: 'log' });
    expect(app.container.get(CONTRACT_VALIDATOR_KEY)).to.not.equal(undefined);
    expect(app.container.get(CONTRACT_VIOLATIONS_KEY)).to.not.equal(undefined);
    expect(DI.get(Configuration)).to.equal(app.config);
    await app.dispose();
  });

  it('rejects dispose when a response broke its contract, and still restores root', async () => {
    const app = await createTestApp({ bootstrap: false, config: {}, contractTesting: { manifest: manifest() } });
    (app.container.get(CONTRACT_VIOLATIONS_KEY) as { record(v: unknown): void }).record({ controller: 'A', handler: 'get', kind: 'response', status: 200, errors: [{ message: 'bad' }] });
    expect(app.contractViolations).to.have.length(1);
    const error = await app.dispose().then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error?.message).to.match(/1 response\(s\) broke their contract[\s\S]*A\.get 200 response/);
    const next = await createTestApp({ bootstrap: false, config: {} });
    await next.dispose();
  });

  it('disposes cleanly without violations and with contractTesting off', async () => {
    const on = await createTestApp({ bootstrap: false, config: {}, scope: 'child', contractTesting: { manifest: manifest() } });
    await on.dispose();
    const off = await createTestApp({ bootstrap: false, config: {} });
    expect(off.contractViolations).to.have.length(0);
    await off.dispose();
  });
});
