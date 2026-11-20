import 'mocha';
import { expect } from 'chai';
import { createConfig, lintFromString } from '@redocly/openapi-core';
import { IDEMPOTENCY_DOC, IDEMPOTENT_REPLAYED_HEADER, PROBLEM_DETAILS_SCHEMA } from '@spinajs/http';
import type { Manifest, RouteEntry } from '@spinajs/manifest';
import { manifestToOpenApi } from '../src/index.js';
import { appBasicManifest } from './support/fixture.js';

type Json = Record<string, unknown>;

interface RouteId {
  method: RouteEntry['method'];
  path: string;
}

const options = { title: 'app-basic', version: '1.0.0', errorSchema: PROBLEM_DETAILS_SCHEMA };
// a body argument, so the builder gives it a generic 400 of its own
const CREATE: RouteId = { method: 'post', path: '/users/create' };
// no request arguments, no @Access, no error map: every 4xx it gets comes from @Idempotent
const HEALTH: RouteId = { method: 'get', path: '/health/get' };

const lint = async (document: unknown): Promise<string[]> => {
  const config = await createConfig({ extends: ['minimal'] });
  const problems = await lintFromString({ source: JSON.stringify(document), absoluteRef: 'x.openapi.json', config });
  return problems.filter((p) => p.severity === 'error').map((p) => p.message);
};

describe('manifestToOpenApi: @Idempotent routes', () => {
  let manifest: Manifest;

  before(async () => {
    manifest = await appBasicManifest();
  });

  const routeOf = (m: Manifest, id: RouteId): RouteEntry => {
    const found = m.controllers.flatMap((c) => c.routes).find((r) => r.method === id.method && r.fullPath === id.path);
    if (!found) throw new Error(`app-basic has no route ${id.method} ${id.path}`);
    return found;
  };

  const withIdempotency = (id: RouteId, required: boolean, change: (route: RouteEntry) => void = () => undefined): Manifest => {
    const copy = structuredClone(manifest);
    const route = routeOf(copy, id);
    route.idempotency = { required };
    change(route);
    return copy;
  };

  const operationOf = (m: Manifest, id: RouteId): Json => (manifestToOpenApi(m, options).paths?.[id.path] as Json)[id.method] as Json;
  const responsesOf = (operation: Json): Record<string, Json> => operation.responses as Record<string, Json>;
  const keyParameterOf = (operation: Json): Json | undefined => (operation.parameters as Json[]).find((p) => p.name === 'Idempotency-Key');

  it('documents the key header, the 400, 409 and 422 problems and the replay header, in the words of @spinajs/http', () => {
    const operation = operationOf(withIdempotency(HEALTH, false), HEALTH);
    const responses = responsesOf(operation);
    expect(keyParameterOf(operation)).to.deep.equal({ name: 'Idempotency-Key', in: 'header', required: false, description: IDEMPOTENCY_DOC.keyDescription, schema: { ...IDEMPOTENCY_DOC.keySchema } });
    for (const status of ['400', '409', '422'] as const) {
      expect(responses[status].description).to.equal(IDEMPOTENCY_DOC.answers[status]);
      expect(Object.keys(responses[status].content as Json)).to.deep.equal(['application/problem+json']);
    }
    expect(responses['400']).to.not.have.property('headers');
    expect(responses['409'].headers).to.deep.equal({ 'Retry-After': { description: IDEMPOTENCY_DOC.retryAfterDescription, schema: { type: 'integer' } } });
    expect(responses['200'].headers).to.deep.equal({ [IDEMPOTENT_REPLAYED_HEADER]: { description: IDEMPOTENCY_DOC.replayedDescription, schema: { type: 'string' } } });
  });

  it('marks the header required for a required key', () => {
    expect(keyParameterOf(operationOf(withIdempotency(CREATE, true), CREATE))?.required).to.equal(true);
  });

  it('keeps the generic 400 of a route with request arguments, and adds the 409 and the 422', () => {
    const responses = responsesOf(operationOf(withIdempotency(CREATE, false), CREATE));
    expect(responses['400'].description).to.equal('Bad request');
    expect(responses['409'].description).to.equal(IDEMPOTENCY_DOC.answers['409']);
    expect(responses['422'].description).to.equal(IDEMPOTENCY_DOC.answers['422']);
  });

  it('leaves a 409 the route documents itself as it is, without Retry-After', () => {
    const documented = withIdempotency(HEALTH, false, (route) => {
      route.doc = { ...route.doc, responses: [{ status: 409, description: 'Already exists' }] };
    });
    const conflict = responsesOf(operationOf(documented, HEALTH))['409'];
    expect(conflict.description).to.equal('Already exists');
    expect(conflict).to.not.have.property('headers');
  });

  it('keeps the header parameter of a route that reads Idempotency-Key itself, whose wire name the compiler lower-cases', () => {
    const reading = withIdempotency(CREATE, true, (route) => {
      route.params.push({ index: route.params.length, name: 'key', kind: 'FromHeader', runtimeType: { text: 'string' }, required: true, wire: { in: 'header', name: 'idempotency-key', shape: 'value' } });
    });
    const headers = (operationOf(reading, CREATE).parameters as Json[]).filter((p) => p.in === 'header');
    expect(headers).to.deep.equal([{ name: 'idempotency-key', in: 'header', required: true, schema: {} }]);
  });

  it('leaves a route without @Idempotent as it was', () => {
    const operation = operationOf(manifest, CREATE);
    expect(keyParameterOf(operation)).to.equal(undefined);
    expect(JSON.stringify(operation)).to.not.include('Idempotency-Key');
    expect(JSON.stringify(operation)).to.not.include(IDEMPOTENT_REPLAYED_HEADER);
    expect(responsesOf(operation)).to.not.have.property('409');
  });

  it('lints clean', async () => {
    expect(await lint(manifestToOpenApi(withIdempotency(CREATE, true), options))).to.deep.equal([]);
  });
});
