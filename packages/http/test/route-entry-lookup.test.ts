import 'mocha';
import { expect } from 'chai';
import type { ControllerEntry, Manifest } from '@spinajs/manifest';

import { routeEntryOf } from '../src/route-args/manifest-schema.js';
import { RouteType, type IRoute } from '../src/interfaces.js';

const CONTROLLERS = 50;

function routeOf(method: string): IRoute {
  return { InternalType: RouteType.GET, Method: method, Middlewares: [], Parameters: new Map(), Path: '', Policies: [], Type: RouteType.GET, Options: null, Schema: null };
}

/** Each entry counts the reads of its class name, the key every lookup compares. */
function manifestOf(reads: { count: number }): Manifest {
  const controllers = Array.from({ length: CONTROLLERS }, (_, i) => {
    const entry = {
      source: { package: 'app', file: `src/controllers/C${i}.ts`, line: 1, col: 1 },
      basePath: `c${i}`,
      routes: [{ handler: 'get', path: '', fullPath: `/c${i}/get`, params: [] }],
    } as unknown as ControllerEntry;
    Object.defineProperty(entry, 'className', {
      enumerable: true,
      get: () => {
        reads.count++;
        return `C${i}`;
      },
    });
    return entry;
  });
  return { controllers, controllerBases: [] } as unknown as Manifest;
}

describe('the manifest entry of a route', () => {
  it('finds each controller route', () => {
    const manifest = manifestOf({ count: 0 });
    for (let i = 0; i < CONTROLLERS; i++) {
      const entry = routeEntryOf(manifest, [{ name: `C${i}` }], routeOf('get'), `c${i}`);
      expect(entry?.fullPath).to.eq(`/c${i}/get`);
    }
    expect(routeEntryOf(manifest, [{ name: 'Missing' }], routeOf('get'), 'missing')).to.eq(undefined);
  });

  it('does not walk every controller entry for each route', () => {
    const reads = { count: 0 };
    const manifest = manifestOf(reads);
    for (let i = 0; i < CONTROLLERS; i++) routeEntryOf(manifest, [{ name: `C${i}` }], routeOf('get'), `c${i}`);
    expect(reads.count).to.be.at.most(CONTROLLERS);
  });
});
