import * as chai from 'chai';
import 'mocha';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as root from '../../src/index.js';
import * as boot from '../../src/service/boot/index.js';

const expect = chai.expect;
const PACKAGE_JSON = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'package.json');

describe('the @spinajs/authn/boot entry', () => {
  it('holds the boot checks and helpers', () => {
    expect(Object.keys(boot)).to.include.members(['checkAuthnConfig', 'checkAuthnSecrets', 'authnSecretFindings', 'secretStoringSteps', 'safeMessage', 'isLenientAuthnEnv', 'authnAppEnv', 'authnEnvFellBack', 'AUTHN_ENV_FALLBACK_WARNING', 'AUTHN_PUBLIC_COOKIE_SECRET']);
  });

  it('is not re-exported from the root entry, which keeps the schema bootstrapper', () => {
    expect(Object.keys(root).filter((name) => name in boot)).to.deep.eq([]);
    expect(root).to.have.property('AuthnConfigBootstrapper');
  });

  it('is a package subpath, ESM and CommonJS', () => {
    const exports = (JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { exports: Record<string, Record<string, string>> }).exports;
    expect(exports['./boot']).to.deep.eq({ types: './lib/service/boot/index.d.ts', import: './lib/service/boot/index.js' });
  });
});
