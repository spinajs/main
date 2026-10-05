import 'mocha';
import { expect } from 'chai';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONTROLLED_DESCRIPTOR_SYMBOL, buildRoutePath } from '@spinajs/http';
import type { IControllerDescriptor } from '@spinajs/http';

import shipped from '../../src/config/authn-http.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/** The 2.x account controllers the 3.0 ones replace; N8c takes them out of the scan (N8a-D6). */
const REPLACED_2X = ['LoginController', 'TwoFactorAuthController', 'SessionsController', 'ActiveRoleController', 'ImpersonationController'];

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

describe('the N8c controller swap (route table)', function () {
  this.timeout(30000);

  it('the shipped config scans the 2.x account and token controllers only, never the 3.0 ones', () => {
    const dirs = shipped.system.dirs.controllers.map((d: string) => d.replace(/\\/g, '/'));
    expect(dirs.some((d: string) => d.endsWith('/account/controllers'))).to.eq(true);
    expect(dirs.some((d: string) => d.endsWith('/token/controllers'))).to.eq(true);
    expect(dirs.filter((d: string) => d.includes('/v3/'))).to.deep.eq([]);
  });

  it('today: the shipped scan registers no method and path twice', async () => {
    const today = [...(await routesOf('account/controllers')), ...(await routesOf('token/controllers'))];
    expect(twice(today)).to.deep.eq([]);
  });

  it('the 3.0 controllers collide only with the five 2.x controllers they replace, so both cannot be scanned at once', async () => {
    const v3 = await routesOf('v3/controllers');
    const today = [...(await routesOf('account/controllers')), ...(await routesOf('token/controllers'))];
    const clashes = today.filter((m) => v3.some((x) => x.route === m.route));
    expect(clashes.length).to.be.greaterThan(0);
    expect([...new Set(clashes.map((m) => m.controller))].every((c) => REPLACED_2X.includes(c)), JSON.stringify(clashes)).to.eq(true);
  });

  it('after N8c: the 3.0 controllers, the token controllers and the account controllers that stay register no method and path twice', async () => {
    const kept = (await routesOf('account/controllers')).filter((m) => !REPLACED_2X.includes(m.controller));
    expect([...new Set(kept.map((m) => m.controller))].sort()).to.deep.eq(['PasswordResetController', 'TwoFactorAuthUserController']);
    const after = [...(await routesOf('v3/controllers')), ...(await routesOf('token/controllers')), ...kept];
    expect(twice(after)).to.deep.eq([]);
  });
});
