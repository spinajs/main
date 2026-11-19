import 'mocha';
import { expect } from 'chai';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { dirWithParent } from '../src/config/authz-http.js';

describe('authz-http package config, controllers one directory up', () => {
  let base: string;
  let app: string;
  const flavour = typeof module !== 'undefined' ? 'cjs' : 'mjs';
  const installed = (root: string) => resolve(root, 'node_modules', '@spinajs', 'authz-http', 'lib', flavour, 'controllers');

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'authz-http-dirs-'));
    app = join(base, 'app');
    mkdirSync(app);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('lists only the app directory when the parent has no installed authz-http', () => {
    expect(dirWithParent('controllers', app)).to.deep.equal([installed(app)]);
  });

  it('lists the parent directory too when authz-http is installed there', () => {
    mkdirSync(installed(base), { recursive: true });

    expect(dirWithParent('controllers', app)).to.deep.equal([installed(app), installed(base)]);
  });
});
