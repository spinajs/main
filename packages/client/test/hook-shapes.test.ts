import 'mocha';
import { expect } from 'chai';
import type { ControllerEntry, Manifest, SocketControllerEntry } from '@spinajs/manifest';
import { generateClientFiles } from '../src/index.js';
import { appBasicManifest } from './support/fixture.js';
import { pagedManifest } from './support/paged.js';
import { typecheckFiles } from './support/typecheck.js';

const source = { line: 1, col: 1, file: 'x.ts', package: 'x' };

function socketController(events: string[], streams: string[]): SocketControllerEntry {
  return {
    id: 'x:ChatSocketController',
    className: 'ChatSocketController',
    prefix: 'chat',
    commands: streams.map((name) => ({ name, handler: name, payload: { text: 'string' }, result: { text: 'number' }, stream: true, options: {}, policies: [], source })),
    events: events.map((name) => ({ name, payload: { text: 'string' } })),
    source,
  };
}

const keepRoutes = (entries: ControllerEntry[], keep: (method: string) => boolean): ControllerEntry[] => entries.map((c) => ({ ...c, routes: c.routes.filter((r) => keep(r.method)) }));

/** app-basic with only the routes `keep` accepts, inherited ones included, and the given socket controllers. */
function shape(base: Manifest, keep: (method: string) => boolean, socketControllers: SocketControllerEntry[] = []): Manifest {
  return { ...base, controllers: keepRoutes(base.controllers, keep), controllerBases: keepRoutes(base.controllerBases ?? [], keep), socketControllers };
}

describe('generated hook files for every manifest shape', function () {
  this.timeout(120000);

  let base: Manifest;
  let paged: Manifest;
  before(async () => {
    [base, paged] = await Promise.all([appBasicManifest(), pagedManifest()]);
  });

  const SHAPES: [string, (m: Manifest) => Manifest][] = [
    ['queries only', (m) => shape(m, (method) => method === 'get')],
    ['mutations only', (m) => shape(m, (method) => method !== 'get')],
    ['no routes at all', (m) => shape(m, () => false)],
    ['socket events only', (m) => shape(m, () => false, [socketController(['message'], [])])],
    ['socket streams only', (m) => shape(m, () => false, [socketController([], ['history'])])],
    ['infinite queries and mutations', () => paged],
    ['infinite queries only', () => shape(paged, (method) => method === 'get')],
  ];

  for (const [name, build] of SHAPES) {
    it(`type-checks every file with noUnusedLocals and noUnusedParameters: ${name}`, async () => {
      const files = await generateClientFiles({ manifest: build(base), hooks: ['react-query', 'swr'], socketHooks: true });
      const contents = Object.fromEntries(files.map((f) => [f.path, f.contents]));
      expect(typecheckFiles(contents, { noUnusedLocals: true, noUnusedParameters: true })).to.deep.equal([]);
    });
  }
});
