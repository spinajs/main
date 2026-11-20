import { describe, expect, it } from 'vitest';
import { fakeApi, withStatus } from '../test/fake-api';
import { ApiError, getJson, postJson, unwrapSourced } from './client';

describe('getJson', () => {
  it('asks for JSON and returns the parsed body', async () => {
    const api = fakeApi({ 'GET /_studio/api/capabilities': { version: '4.0.0' } });
    await expect(getJson('/_studio/api/capabilities')).resolves.toEqual({ version: '4.0.0' });
    expect(api.fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { Accept: 'application/json' } });
  });

  it('throws an ApiError with the status and the server message', async () => {
    fakeApi({ 'GET /_studio/api/traces': withStatus(403, { message: 'studio:read required' }) });
    const error = await getJson('/_studio/api/traces').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, message: 'studio:read required', url: '/_studio/api/traces' });
  });
});

describe('postJson', () => {
  it('sends a JSON body', async () => {
    const api = fakeApi({ 'POST /_studio/api/authz/explain': { ok: true } });
    await postJson('/_studio/api/authz/explain', { permission: 'invoice:read' });
    expect(api.last('POST /_studio/api/authz/explain').body).toEqual({ permission: 'invoice:read' });
    expect(api.fetch.mock.calls[0][1]).toMatchObject({ headers: { 'Content-Type': 'application/json' } });
  });
});

describe('unwrapSourced', () => {
  it('reads a { source, data } envelope', () => {
    expect(unwrapSourced({ source: 'merged', data: [1, 2] })).toEqual({ source: 'merged', data: [1, 2] });
  });

  it('passes a bare value through', () => {
    expect(unwrapSourced([1, 2])).toEqual({ data: [1, 2] });
    expect(unwrapSourced<{ data: number; source: string }>({ data: 1, source: 'elsewhere' })).toEqual({ data: { data: 1, source: 'elsewhere' } });
  });
});
