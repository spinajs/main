import { expect } from 'chai';
import 'mocha';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { diffManifest, publishedManifest, validateManifest } from '../src/index.js';
import type { Manifest } from '../src/index.js';

const fixture = fileURLToPath(new URL('../../compiler/test/fixtures/app-basic/app.manifest.json', import.meta.url));
const load = (): Manifest => JSON.parse(readFileSync(fixture, 'utf8')) as Manifest;

function flagged(): Manifest {
  const m = load();
  for (const entries of [m.controllers, m.socketControllers, m.schedules, m.commands, m.migrations]) {
    for (const entry of entries) entry.mountedBy = 'di';
  }
  return m;
}

describe('entries a registration has to serve', () => {
  it('validates: the field is an addition to version 2', () => {
    expect(validateManifest(flagged())).to.deep.equal([]);
  });

  it('are left out of what the published surface describes, and nothing else is', () => {
    const m = flagged();
    const published = publishedManifest(m);
    expect(published.controllers).to.deep.equal([]);
    expect(published.socketControllers).to.deep.equal([]);
    expect(published.schedules).to.deep.equal([]);
    expect(published.commands).to.deep.equal([]);
    expect(published.migrations).to.deep.equal([]);
    expect(published.models).to.deep.equal(m.models);
    expect(published.schemas).to.equal(m.schemas);
    expect(published.hash).to.equal(m.hash);
  });

  it('returns a manifest without such entries unchanged', () => {
    const m = load();
    expect(publishedManifest(m).controllers).to.deep.equal(m.controllers);
  });

  it('count as removed in a diff, because the manifest no longer serves them', () => {
    const base = load();
    const removed = diffManifest(base, flagged()).changes.filter((c) => c.section === 'routes' && c.kind === 'removed');
    expect(removed.length).to.equal(base.controllers.flatMap((c) => c.routes).length);
    expect(removed.every((c) => c.breaking)).to.equal(true);
  });
});
