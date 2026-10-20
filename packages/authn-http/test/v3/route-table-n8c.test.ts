import 'mocha';
import { expect } from 'chai';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONTROLLED_DESCRIPTOR_SYMBOL, buildRoutePath } from '@spinajs/http';
import type { IControllerDescriptor } from '@spinajs/http';

import shipped from '../../src/config/authn-http.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

interface Mounted {
  controller: string;
  route: string;
}

async function routesOf(dir: string): Promise<Mounted[]> {
  const out: Mounted[] = [];
  for (const file of readdirSync(join(SRC, dir)).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))) {
    const mod = (await import(pathToFileURL(join(SRC, dir, file)).href)) as Record<string, unknown>;
    for (const value of Object.values(mod)) {
      if (typeof value !== 'function') continue;
      const descriptor = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, value.prototype) as IControllerDescriptor | undefined;
      if (!descriptor?.Routes) continue;
      const base = descriptor.BasePath || value.name.toLowerCase();
      for (const [, route] of descriptor.Routes) out.push({ controller: value.name, route: `${String(route.InternalType).toUpperCase()} ${buildRoutePath(base, route)}` });
    }
  }
  return out;
}

const twice = (list: Mounted[]) => list.filter((m, i) => list.findIndex((x) => x.route === m.route) !== i).map((m) => `${m.route} (${m.controller})`);

describe('the controller route table', function () {
  this.timeout(30000);

  it('the shipped config scans v3/controllers, nothing else', () => {
    const dirs = shipped.system.dirs.controllers.map((d: string) => d.replace(/\\/g, '/'));
    expect(dirs.some((d: string) => d.endsWith('/v3/controllers')), 'v3/controllers').to.eq(true);
    expect(dirs.filter((d: string) => !d.endsWith('/v3/controllers'))).to.deep.eq([]);
  });

  it('the controllers register no method and path twice', async () => {
    expect(twice(await routesOf('v3/controllers'))).to.deep.eq([]);
  });
});
