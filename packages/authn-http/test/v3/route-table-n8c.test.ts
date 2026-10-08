import 'mocha';
import { expect } from 'chai';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONTROLLED_DESCRIPTOR_SYMBOL, buildRoutePath } from '@spinajs/http';
import type { IControllerDescriptor } from '@spinajs/http';

import shipped from '../../src/config/authn-http.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/** The 2.x controller dirs the shipped config scans beside v3/controllers, and the controllers in them: none since N8b task 9. */
const SCANNED_2X_DIRS: string[] = [];
const SCANNED_2X_CONTROLLERS: string[] = [];

/** The 2.x account controllers the 3.0 ones replace; C3b deleted them with their account/legacy files. */
const DELETED_2X = ['LoginController', 'TwoFactorAuthController', 'SessionsController', 'ActiveRoleController', 'ImpersonationController'];

/** The 2.x account controllers N8b parked in account/legacy: compiled, never scanned (N8b task 9). */
const PARKED_2X = ['PasswordResetController', 'TwoFactorAuthUserController'];

/** Every 2.x credential controller 3.0 retires (`RETIRED_2X` of .authz-sdd/N8b-N8c-addendum.md). */
const RETIRED_2X = [...DELETED_2X, ...PARKED_2X, 'AccessTokenController'];

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

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));

const twice = (list: Mounted[]) => list.filter((m, i) => list.findIndex((x) => x.route === m.route) !== i).map((m) => `${m.route} (${m.controller})`);
const controllersOf = (list: Mounted[]) => [...new Set(list.map((m) => m.controller))].sort();

describe('the N8c controller swap (route table)', function () {
  this.timeout(30000);

  it('the shipped config scans v3/controllers and the 2.x dirs that stay, nothing else', () => {
    const dirs = shipped.system.dirs.controllers.map((d: string) => d.replace(/\\/g, '/'));
    const expected = ['v3/controllers', ...SCANNED_2X_DIRS];
    for (const dir of expected)
      expect(
        dirs.some((d: string) => d.endsWith(`/${dir}`)),
        dir,
      ).to.eq(true);
    expect(dirs.filter((d: string) => !expected.some((dir) => d.endsWith(`/${dir}`)))).to.deep.eq([]);
  });

  it('the scanned 2.x dirs hold only the 2.x controllers that stay; the deleted ones are gone from the sources', async () => {
    const scanned = (await Promise.all(SCANNED_2X_DIRS.map(routesOf))).flat();
    expect(controllersOf(scanned)).to.deep.eq(SCANNED_2X_CONTROLLERS);
    const defining = new RegExp(`class (${DELETED_2X.join('|')})\\b`);
    expect(sourceFiles(SRC).filter((f) => defining.test(readFileSync(f, 'utf8')))).to.deep.eq([]);
  });

  it('the unscanned token/controllers holds AccessTokenController alone, and the retired set equals the addendum RETIRED_2X', async () => {
    const token = await routesOf('token/controllers');
    expect(controllersOf(token)).to.deep.eq(['AccessTokenController']);
    expect(existsSync(join(SRC, 'account', 'controllers')), 'account/controllers is gone').to.eq(false);
    expect(controllersOf(await routesOf('account/legacy'))).to.deep.eq([...PARKED_2X].sort());
    expect([...DELETED_2X, ...controllersOf([...(await routesOf('account/legacy')), ...token])].sort()).to.deep.eq([...RETIRED_2X].sort());
  });

  it('after N8c: the 3.0 controllers and the scanned 2.x ones register no method and path twice', async () => {
    const after = [...(await routesOf('v3/controllers')), ...(await Promise.all(SCANNED_2X_DIRS.map(routesOf))).flat()];
    expect(twice(after)).to.deep.eq([]);
  });
});
