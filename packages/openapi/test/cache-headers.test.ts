import 'mocha';
import { expect } from 'chai';
import { createConfig, lintFromString } from '@redocly/openapi-core';
import { CacheControl, PROBLEM_DETAILS_SCHEMA } from '@spinajs/http';
import type { ICacheControlOptions } from '@spinajs/http';
import type { ControllerEntry, Manifest, MiddlewareRef, RouteEntry } from '@spinajs/manifest';
import type { OpenAPIV3_1 } from 'openapi-types';
import { manifestToOpenApi } from '../src/index.js';
import { appBasicManifest } from './support/fixture.js';

const options = { title: 'app-basic', version: '1.0.0', errorSchema: PROBLEM_DETAILS_SCHEMA };

type Headers = Record<string, { description?: string; schema?: unknown; example?: unknown }>;

const cacheControl = (...args: unknown[]): MiddlewareRef => ({ type: 'CacheControl', options: args });
const noStore: MiddlewareRef = { type: 'NoStore', options: [] };

const lint = async (document: unknown): Promise<string[]> => {
  const config = await createConfig({ extends: ['minimal'] });
  const problems = await lintFromString({ source: JSON.stringify(document), absoluteRef: 'x.openapi.json', config });
  return problems.filter((p) => p.severity === 'error').map((p) => p.message);
};

const responseOf = (operation: OpenAPIV3_1.OperationObject | undefined, status: string): OpenAPIV3_1.ResponseObject | undefined => operation?.responses?.[status] as OpenAPIV3_1.ResponseObject | undefined;
const headersOf = (operation: OpenAPIV3_1.OperationObject | undefined, status: string): Headers => responseOf(operation, status)?.headers ?? {};

/** The value `CacheControl` of `@spinajs/http` writes on a 2xx reply nothing makes private, read from the middleware itself. */
class WrittenValue extends CacheControl {
  public get written(): string {
    return this.scope ? `${this.scope}, ${this.directives}` : this.directives;
  }
}

describe('manifestToOpenApi: caching headers', () => {
  let manifest: Manifest;

  before(async () => {
    manifest = await appBasicManifest();
  });

  /** A copy of the manifest with `mark` applied to UsersController. */
  function users(mark: (owner: ControllerEntry, route: (path: string) => RouteEntry) => void): Manifest {
    const copy = structuredClone(manifest);
    const owner = copy.controllers.find((c) => c.className === 'UsersController')!;
    mark(owner, (path) => owner.routes.find((r) => r.fullPath === path)!);
    return copy;
  }

  it('documents Cache-Control, Vary, ETag and a 304 without a body for a route declaration', async () => {
    const m = users((_, route) => {
      route('/users/:id').middlewares.push(cacheControl(300, { public: true, staleWhileRevalidate: 60, immutable: true, vary: ['Cookie', 'Accept-Language'] }));
    });
    const doc = manifestToOpenApi(m, options);
    const get = doc.paths!['/users/{id}']!.get!;
    const headers = headersOf(get, '200');
    expect(Object.keys(headers)).to.deep.equal(['Cache-Control', 'Vary', 'ETag']);
    expect(headers['Cache-Control'].example).to.equal('public, max-age=300, stale-while-revalidate=60, immutable');
    expect(headers.Vary.example).to.equal('Cookie, Accept-Language');
    expect(headers.ETag).to.not.have.property('example');
    expect(headersOf(get, '304')).to.deep.equal(headers);
    expect(responseOf(get, '304')).to.not.have.property('content');
    expect(await lint(doc)).to.deep.equal([]);
  });

  it('writes the Cache-Control example CacheControl of @spinajs/http sends', () => {
    const cases: [number | undefined, ICacheControlOptions | undefined][] = [
      [undefined, undefined],
      [60, undefined],
      [300, { private: true, staleWhileRevalidate: 30 }],
      [0, { public: true, immutable: true, redirects: true }],
    ];
    for (const [maxAge, opts] of cases) {
      const args = opts === undefined ? (maxAge === undefined ? [] : [maxAge]) : [maxAge, opts];
      const m = users((_, route) => {
        route('/users/:id').middlewares.push(cacheControl(...args));
      });
      const example = headersOf(manifestToOpenApi(m, options).paths!['/users/{id}']!.get, '200')['Cache-Control'].example;
      expect(example, JSON.stringify(args)).to.equal(new WrittenValue(maxAge, opts).written);
    }
  });

  it('applies a controller declaration to its GET routes only', () => {
    const m = users((owner) => {
      owner.middlewares.push(cacheControl(60));
    });
    const doc = manifestToOpenApi(m, options);
    expect(headersOf(doc.paths!['/users/list']!.get, '200')['Cache-Control'].example).to.equal('max-age=60');
    expect(headersOf(doc.paths!['/users/{id}']!.get, '200')['Cache-Control'].example).to.equal('max-age=60');
    const create = doc.paths!['/users/create']!.post!;
    expect(Object.keys(headersOf(create, '200'))).to.deep.equal([]);
    expect(create.responses).to.not.have.property('304');
  });

  it("takes Cache-Control from the route's declaration and Vary from both, as the two onAfter hooks write them", () => {
    const m = users((owner, route) => {
      owner.middlewares.push(cacheControl(60, { vary: ['Cookie', 'accept-language'] }));
      route('/users/:id').middlewares.push(cacheControl(10, { private: true, vary: ['Accept-Language'] }));
    });
    const doc = manifestToOpenApi(m, options);
    const own = headersOf(doc.paths!['/users/{id}']!.get, '200');
    expect(own['Cache-Control'].example).to.equal('private, max-age=10');
    expect(own.Vary.example).to.equal('Accept-Language, Cookie');
    expect(headersOf(doc.paths!['/users/list']!.get, '200')['Cache-Control'].example).to.equal('max-age=60');
  });

  it('leaves ETag and the 304 out when the app sends no ETag', () => {
    const m = users((_, route) => {
      route('/users/:id').middlewares.push(cacheControl(300));
    });
    const get = manifestToOpenApi(m, { ...options, etag: false }).paths!['/users/{id}']!.get!;
    expect(Object.keys(headersOf(get, '200'))).to.deep.equal(['Cache-Control']);
    expect(get.responses).to.not.have.property('304');
  });

  it('documents a declaration whose arguments the build could not read without an example', () => {
    const m = users((_, route) => {
      route('/users/:id').middlewares.push({ type: 'CacheControl' });
    });
    const get = manifestToOpenApi(m, options).paths!['/users/{id}']!.get!;
    const headers = headersOf(get, '200');
    expect(Object.keys(headers)).to.deep.equal(['Cache-Control', 'ETag']);
    expect(headers['Cache-Control']).to.not.have.property('example');
    expect(get.responses).to.have.property('304');
  });

  it('documents NoStore as no-store over CacheControl, with the ETag and 304 Express still sends', () => {
    const m = users((owner, route) => {
      owner.middlewares.push(cacheControl(60, { vary: ['Cookie'] }));
      route('/users/:id').middlewares.push(noStore);
    });
    const doc = manifestToOpenApi(m, options);
    const get = doc.paths!['/users/{id}']!.get!;
    const headers = headersOf(get, '200');
    expect(Object.keys(headers)).to.deep.equal(['Cache-Control', 'Pragma', 'Vary', 'ETag']);
    expect(headers['Cache-Control'].example).to.equal('no-store');
    expect(headers.Pragma.example).to.equal('no-cache');
    expect(headers.Vary.example).to.equal('Cookie');
    expect(headersOf(get, '304')).to.deep.equal(headers);
    expect(headersOf(doc.paths!['/users/list']!.get, '200')['Cache-Control'].example).to.equal('max-age=60');
  });

  it('documents NoStore on a POST route without Vary or a 304', () => {
    const m = users((_, route) => {
      route('/users/create').middlewares.push(noStore, cacheControl(60, { vary: ['Cookie'] }));
    });
    const create = manifestToOpenApi(m, options).paths!['/users/create']!.post!;
    expect(Object.keys(headersOf(create, '200'))).to.deep.equal(['Cache-Control', 'Pragma', 'ETag']);
    expect(create.responses).to.not.have.property('304');
  });

  it('puts no ETag on a 204 and no 304 on a route that answers no body', () => {
    const m = users((_, route) => {
      const target = route('/users/:id');
      target.returnType = { text: 'void' };
      target.middlewares.push(cacheControl(60));
    });
    const get = manifestToOpenApi(m, options).paths!['/users/{id}']!.get!;
    expect(Object.keys(headersOf(get, '204'))).to.deep.equal(['Cache-Control']);
    expect(get.responses).to.not.have.property('304');
  });

  it('adds its headers after the replay header of an @Idempotent route, and keeps that one', () => {
    const m = users((_, route) => {
      const target = route('/users/:id');
      target.idempotency = { required: false };
      target.middlewares.push(cacheControl(300));
    });
    const get = manifestToOpenApi(m, options).paths!['/users/{id}']!.get!;
    expect(Object.keys(headersOf(get, '200'))).to.deep.equal(['Idempotent-Replayed', 'Cache-Control', 'ETag']);
    expect(Object.keys(headersOf(get, '304'))).to.deep.equal(['Idempotent-Replayed', 'Cache-Control', 'ETag']);
    expect(Object.keys(headersOf(get, '409'))).to.deep.equal(['Retry-After']);
  });
});
