import { expect } from 'chai';
import 'mocha';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { diffManifest } from '../src/index.js';
import type { Change, Manifest, RouteEntry } from '../src/index.js';

const fixture = fileURLToPath(new URL('../../compiler/test/fixtures/app-basic/app.manifest.json', import.meta.url));
const base = JSON.parse(readFileSync(fixture, 'utf8')) as Manifest;
const clone = (): Manifest => JSON.parse(JSON.stringify(base)) as Manifest;
const create = (m: Manifest): RouteEntry => m.controllers.flatMap((c) => c.routes).find((r) => r.method === 'post' && r.fullPath === '/users/create')!;
const routeChange = (b: Manifest, h: Manifest): Change | undefined => diffManifest(b, h).changes.find((c) => c.section === 'routes' && c.id === 'POST /users/create');

describe('diffManifest: @Idempotent', () => {
  it('reports an optional @Idempotent added as a non-breaking change', () => {
    const head = clone();
    create(head).idempotency = { required: false };
    expect(routeChange(base, head)).to.deep.equal({ section: 'routes', kind: 'changed', id: 'POST /users/create', breaking: false, detail: '@Idempotent added' });
  });

  it('reports a required @Idempotent added as breaking', () => {
    const head = clone();
    create(head).idempotency = { required: true };
    expect(routeChange(base, head)).to.include({ breaking: true, detail: '@Idempotent added with a required Idempotency-Key' });
  });

  it('reports @Idempotent removed as breaking', () => {
    const before = clone();
    create(before).idempotency = { required: false };
    expect(routeChange(before, clone())).to.include({ breaking: true, detail: '@Idempotent removed: a retried request runs again' });
  });

  it('reports a key that becomes required as breaking and one that stops being required as not', () => {
    const optional = clone();
    create(optional).idempotency = { required: false };
    const required = clone();
    create(required).idempotency = { required: true };
    expect(routeChange(optional, required)).to.include({ breaking: true, detail: 'Idempotency-Key is now required' });
    expect(routeChange(required, optional)).to.include({ breaking: false, detail: 'Idempotency-Key is no longer required' });
  });

  it('reports nothing when the options stay', () => {
    const a = clone();
    create(a).idempotency = { required: true };
    const b = clone();
    create(b).idempotency = { required: true };
    expect(routeChange(a, b)).to.equal(undefined);
  });
});
