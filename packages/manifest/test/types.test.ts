import { expect } from 'chai';
import 'mocha';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MANIFEST_VERSION, manifestSchema, validateFragment, validateManifest } from '../src/index.js';
import { generate } from '../scripts/generate-schema.mjs';

const file = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

describe('manifest types and schema', () => {
  it('pins manifest version 2', () => {
    expect(MANIFEST_VERSION).to.equal(2);
  });

  it('committed schema.json matches a fresh generation from types.ts', function () {
    this.timeout(60000);
    expect(JSON.parse(readFileSync(file('../src/schema.json'), 'utf8'))).to.deep.equal(generate());
  });

  it('has no offset-derived definition names', () => {
    expect(Object.keys(manifestSchema.definitions).filter((n) => /src_types.ts|structure-/.test(n))).to.deep.equal([]);
  });

  it('never forbids additional properties, so readers ignore unknown fields', () => {
    expect(JSON.stringify(manifestSchema)).to.not.contain('"additionalProperties": false');
    expect(JSON.stringify(manifestSchema)).to.not.contain('"additionalProperties":false');
  });

  it('schema.ts mirrors schema.json', () => {
    expect(manifestSchema).to.deep.equal(JSON.parse(readFileSync(file('../src/schema.json'), 'utf8')));
  });

  it('accepts the minimal fixture', () => {
    expect(validateManifest(JSON.parse(readFileSync(file('./fixtures/minimal.manifest.json'), 'utf8')))).to.deep.equal([]);
  });

  describe('route pagination', () => {
    const src = { file: 'src/x.ts', line: 1, col: 1, package: 'demo-app' };
    const withRoute = (extra: Record<string, unknown>) => {
      const m = JSON.parse(readFileSync(file('./fixtures/minimal.manifest.json'), 'utf8')) as { controllers: unknown[] };
      const route = { method: 'get', path: '', handler: 'list', fullPath: '/users/list', params: [], returnType: { text: 'Page<UserDto>' }, policies: [], middlewares: [], source: src, ...extra };
      m.controllers.push({ id: 'demo-app:Users', className: 'Users', basePath: 'users', policies: [], middlewares: [], routes: [route], source: src });
      return m;
    };

    it('accepts a route without it and one with it', () => {
      expect(validateManifest(withRoute({}))).to.deep.equal([]);
      const pagination = { kind: 'offset', item: { text: 'UserDto' }, param: { arg: 'query', path: ['page'] }, size: { arg: 'query', path: ['pageSize'] }, firstPage: 1 };
      expect(validateManifest(withRoute({ pagination }))).to.deep.equal([]);
    });

    it('rejects an unknown kind', () => {
      expect(validateManifest(withRoute({ pagination: { kind: 'page', item: { text: 'UserDto' } } }))).to.not.be.empty;
    });
  });

  it('rejects a manifest that lacks required members', () => {
    expect(validateManifest({ manifestVersion: 2 })).to.not.be.empty;
    expect(validateFragment({ manifestVersion: 2 })).to.not.be.empty;
  });
});
