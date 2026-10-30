import { expect } from 'chai';
import type { ParamWire } from '@spinajs/manifest';
import { createProgramFromTsconfig, createContext, extractControllers } from '../../src/index.js';

describe('route argument wire format', () => {
  const unit = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
  const ctx = createContext(unit, 'unit', 'test/fixtures/unit');
  const [wire] = extractControllers(ctx, unit.sourceFiles.find((f) => f.fileName.endsWith('route-wire.ts'))!);
  const wireOf = (handler: string): Record<string, ParamWire | undefined> =>
    Object.fromEntries(wire.routes.find((r) => r.handler === handler)!.params.map((p) => [p.name, p.wire]));

  it('@Query: a primitive, literal union, enum or hydrated DateTime is a value, anything else is JSON under the parameter name', () => {
    expect(wireOf('query')).to.deep.equal({
      query: { in: 'query', name: 'query', shape: 'json' },
      dto: { in: 'query', name: 'dto', shape: 'json' },
      page: { in: 'query', name: 'page', shape: 'value' },
      verbose: { in: 'query', name: 'verbose', shape: 'value' },
      color: { in: 'query', name: 'color', shape: 'value' },
      mode: { in: 'query', name: 'mode', shape: 'value' },
      mixed: { in: 'query', name: 'mixed', shape: 'json' },
      ids: { in: 'query', name: 'ids', shape: 'json' },
      at: { in: 'query', name: 'at', shape: 'value' },
      h: { in: 'query', name: 'h', shape: 'value' },
    });
  });

  it('reports a custom hydrator as undecided instead of guessing silently', () => {
    expect(ctx.diagnostics.filter((d) => d.code === 'CMP005').map((d) => d.message)).to.deep.equal([
      'h is converted by CustomHydrator, which receives the raw string; the manifest records it as a plain value',
    ]);
  });

  it('whole-container arguments carry no name', () => {
    expect(wireOf('fields')).to.deep.equal({
      q: { in: 'query', shape: 'whole' },
      p: { in: 'path', shape: 'whole' },
      h: { in: 'header', shape: 'whole' },
      b: { in: 'body', shape: 'whole' },
      raw: { in: 'body', shape: 'whole' },
      xml: { in: 'body', shape: 'whole' },
      form: { in: 'multipart', shape: 'whole' },
    });
  });

  it('url params follow the type rule; @PKey and @Uuid can move to another location', () => {
    expect(wireOf('params')).to.deep.equal({
      id: { in: 'path', name: 'id', shape: 'value' },
      p: { in: 'path', name: 'p', shape: 'json' },
      key: { in: 'path', name: 'key', shape: 'value' },
      uuid: { in: 'query', name: 'uuid', shape: 'value' },
    });
  });

  it('a header is keyed by the decorator argument, lower-cased, else by the parameter name', () => {
    expect(wireOf('headers')).to.deep.equal({
      tenant: { in: 'header', name: 'x-tenant', shape: 'value' },
      token: { in: 'header', name: 'token', shape: 'value' },
      json: { in: 'header', name: 'x-json', shape: 'json' },
      session: { in: 'cookie', name: 'session', shape: 'value' },
    });
  });

  it('@Body: a single object body is the whole body; several or a primitive are fields', () => {
    expect(wireOf('one')).to.deep.equal({ body: { in: 'body', shape: 'whole' } });
    expect(wireOf('two')).to.deep.equal({ a: { in: 'body', name: 'a', shape: 'field' }, b: { in: 'body', name: 'b', shape: 'field' } });
    expect(wireOf('prim')).to.deep.equal({ email: { in: 'body', name: 'email', shape: 'field' } });
  });

  it('files and form fields are multipart parts under the parameter name', () => {
    expect(wireOf('files')).to.deep.equal({
      avatar: { in: 'multipart', name: 'avatar', shape: 'value' },
      photos: { in: 'multipart', name: 'photos', shape: 'value', multiple: true },
      csv: { in: 'multipart', name: 'csv', shape: 'value' },
      json: { in: 'multipart', name: 'json', shape: 'value' },
      title: { in: 'multipart', name: 'title', shape: 'value' },
      tags: { in: 'multipart', name: 'tags', shape: 'value', multiple: true },
      meta: { in: 'multipart', name: 'meta', shape: 'json' },
    });
  });

  it('injected and user-agent arguments are not sent', () => {
    const none = { in: 'none', shape: 'whole' };
    expect(wireOf('injected')).to.deep.equal({ svc: none, req: none, res: none, ip: none, ua: none });
  });

  it('orm-http @FromModel reads a key, @AsModel a body like @Body', () => {
    expect(wireOf('models')).to.deep.equal({
      id: { in: 'path', name: 'id', shape: 'value' },
      q: { in: 'query', name: 'postId', shape: 'value' },
      body: { in: 'body', shape: 'whole' },
    });
    expect(wireOf('asModels')).to.deep.equal({
      a: { in: 'body', name: 'first', shape: 'field' },
      b: { in: 'body', name: 'b', shape: 'field' },
      c: { in: 'header', name: 'h', shape: 'json' },
    });
  });
});
