import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DI } from '@spinajs/di';
import type { Request } from '@spinajs/http';

import * as barrel from '../../src/index.js';

const PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url));

/** The last stdout line of a node child that loads the built package root the way an app does. */
function typesFromBuiltRoot(args: string[]): string {
  const r = spawnSync(process.execPath, args, { cwd: PACKAGE_DIR, encoding: 'utf8', timeout: 120000 });
  expect(r.status, r.stderr).to.eq(0);
  return r.stdout.trim().split(/\r?\n/).pop() ?? '';
}

describe('assertFreshAuth from the package root (Z8)', function () {
  this.timeout(240000);

  it('the root barrel exports it next to FreshAuth', () => {
    expect(barrel.assertFreshAuth).to.be.a('function');
    expect(barrel.FreshAuth).to.be.a('function');
  });

  it('refuses a request without a principal with 401 unauthenticated', async () => {
    const req = { storage: {}, headers: {} } as unknown as Request;
    const error = await barrel.assertFreshAuth(DI.RootContainer, req).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as { error?: unknown } | null)?.error).to.eq('unauthenticated');
  });

  const PRINT = 'console.log(typeof m.assertFreshAuth, typeof m.FreshAuth); process.exit(0);';
  for (const [how, args] of [
    ['import', ['--input-type=module', '-e', `const m = await import('@spinajs/authn-http'); ${PRINT}`]],
    ['require', ['-e', `const m = require('@spinajs/authn-http'); ${PRINT}`]],
  ] as const) {
    it(`@spinajs/authn-http loaded by ${how} exports it`, () => {
      expect(typesFromBuiltRoot([...args])).to.eq('function function');
    });
  }
});
