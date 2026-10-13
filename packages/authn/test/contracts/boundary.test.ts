import * as chai from 'chai';
import 'mocha';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import * as srcContracts from '../../src/contracts/index.js';

const expect = chai.expect;

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_DIR = join(PKG_ROOT, 'src', 'contracts');
const MJS_DIR = join(PKG_ROOT, 'lib', 'mjs', 'contracts');
const CJS_DIR = join(PKG_ROOT, 'lib', 'cjs', 'contracts');
const ALLOWED_PACKAGES = ['@spinajs/di'];
const RUNTIME_EXPORTS = ['SYSTEM', 'UNATTENDED', 'principalKey', 'ceilingHash', 'AuthenticationStrategy', 'AuthnService', 'PrincipalFactory', 'IdentityStore', 'PasswordCredentialStore', 'IdentityLinkStore', 'SessionIssuer', 'MfaStep', 'MfaPolicy', 'SecretStore', 'AuthnThrottle', 'AuthnEventSink', 'ImpersonationGuard', 'PasswordService', 'TokenService', 'KeyRegistry', 'JwsVerifier', 'JwsSigner', 'CredentialExtractor', 'AuthnResponseExtension', 'RoleSource', 'ExternalLoginHook', 'CredentialAdminGuard'];

// Plain JS so the same code runs in this process and in the child processes.
const EXERCISE = `(c) => ({
  keys: Object.keys(c).sort(),
  pk: [c.principalKey({ type: 'user', id: '42' }), c.principalKey({ type: 'a:b%', id: 'c:d' })],
  ch: [
    c.ceilingHash(undefined),
    c.ceilingHash({}),
    c.ceilingHash({ roles: ['b', 'a', 'a'], permissions: [], resources: [{ type: 'f', id: '1' }, { type: 'f' }], expiresAt: new Date(5), reason: 'r' }),
    c.ceilingHash({ expiresAt: new Date(NaN) }),
  ],
  system: [c.SYSTEM, Object.isFrozen(c.SYSTEM), Object.isFrozen(c.SYSTEM.attributes)],
  unattended: [c.UNATTENDED, Object.isFrozen(c.UNATTENDED), Object.isFrozen(c.UNATTENDED.attributes)],
})`;

// Reads DI internals (protected/private maps) so a registration made at load
// time cannot hide behind the public API.
const SNAPSHOT = `(di) => {
  const root = di.DI.RootContainer;
  const registry = root.Registry.registry;
  const cache = root.Cache.cache;
  if (!(registry instanceof Map) || !(cache instanceof Map)) throw new Error('DI internals changed: registry or cache is not a Map');
  const name = (x) => (typeof x === 'function' ? x.name : x && x.constructor ? x.constructor.name : typeof x);
  return {
    registry: [...registry].map(([k, v]) => [k, v.map(name)]),
    cache: [...cache].map(([k, v]) => [k, v.map(name)]),
    events: root.eventNames().map(String),
  };
}`;

interface ProbeResult {
  diFiles?: string[];
  contractFiles?: string[];
  loaded?: string[];
  before?: unknown;
  after?: unknown;
  exercise?: unknown;
}

function probe(inputType: 'module' | 'commonjs', body: string): ProbeResult {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, [`--input-type=${inputType}`, '-e', body], { cwd: PKG_ROOT, encoding: 'utf8', env });
  if (r.status !== 0) {
    throw new Error(`child node (${inputType}) exited with ${r.status}:\n${r.stderr}`);
  }
  const lines = r.stdout.trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1]) as ProbeResult;
}

function listFiles(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, ext));
    else if (ext.test(e.name)) out.push(p);
  }
  return out;
}

function specifiersOf(file: string): string[] {
  const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
  return [...info.importedFiles, ...info.referencedFiles, ...info.typeReferenceDirectives].map((f) => f.fileName);
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function violations(root: string, ext: RegExp): { found: string[]; bad: string[] } {
  const found: string[] = [];
  const bad: string[] = [];
  for (const file of listFiles(root, ext)) {
    for (const spec of specifiersOf(file)) {
      found.push(spec);
      const ok = spec.startsWith('.') ? isInside(root, resolve(dirname(file), spec)) : ALLOWED_PACKAGES.includes(spec);
      if (!ok) bad.push(`${relative(PKG_ROOT, file)}: ${spec}`);
    }
  }
  return { found, bad };
}

describe('@spinajs/authn/contracts boundary', function () {
  this.timeout(60000);

  let esm: ProbeResult;
  let cjs: ProbeResult;
  let cjsAlone: ProbeResult;

  before(() => {
    for (const f of [join(MJS_DIR, 'index.js'), join(CJS_DIR, 'index.js')]) {
      if (!existsSync(f)) throw new Error(`${f} is missing; run the authn pretest (mjs and cjs compile)`);
    }

    esm = probe(
      'module',
      `const exercise = ${EXERCISE};
       const snapshot = ${SNAPSHOT};
       const di = await import('@spinajs/di');
       const before = snapshot(di);
       const c = await import('@spinajs/authn/contracts');
       const after = snapshot(di);
       console.log(JSON.stringify({ before, after, exercise: exercise(c) }));`,
    );

    cjs = probe(
      'commonjs',
      `const exercise = ${EXERCISE};
       const snapshot = ${SNAPSHOT};
       const initial = new Set(Object.keys(require.cache));
       const di = require('@spinajs/di');
       const diFiles = Object.keys(require.cache).filter((k) => !initial.has(k));
       const before = snapshot(di);
       const c = require('@spinajs/authn/contracts');
       const after = snapshot(di);
       const contractFiles = Object.keys(require.cache).filter((k) => !initial.has(k) && !diFiles.includes(k));
       console.log(JSON.stringify({ diFiles, contractFiles, before, after, exercise: exercise(c) }));`,
    );

    cjsAlone = probe(
      'commonjs',
      `const initial = new Set(Object.keys(require.cache));
       require('@spinajs/authn/contracts');
       console.log(JSON.stringify({ loaded: Object.keys(require.cache).filter((k) => !initial.has(k)) }));`,
    );
  });

  describe('runtime exports', () => {
    it('exist in the ESM build', () => {
      expect((esm.exercise as { keys: string[] }).keys).to.include.members(RUNTIME_EXPORTS);
    });

    it('exist in the CJS build', () => {
      expect((cjs.exercise as { keys: string[] }).keys).to.include.members(RUNTIME_EXPORTS);
    });

    it('behave the same in ESM, CJS and the sources', () => {
      const local = (new Function(`return ${EXERCISE}`)() as (c: unknown) => unknown)(srcContracts);
      expect(esm.exercise).to.deep.eq(cjs.exercise);
      expect(esm.exercise).to.deep.eq(JSON.parse(JSON.stringify(local)));
    });
  });

  describe('imports', () => {
    it('src/contracts imports nothing outside src/contracts except @spinajs/di', () => {
      const { found, bad } = violations(SRC_DIR, /\.ts$/);
      expect(found, 'scanner found no import in src/contracts').to.include('./principal.js');
      expect(bad).to.deep.eq([]);
    });

    it('lib/mjs/contracts imports nothing outside itself except @spinajs/di', () => {
      const { found, bad } = violations(MJS_DIR, /\.js$/);
      expect(found, 'scanner found no import in lib/mjs/contracts').to.include('./principal.js');
      expect(bad).to.deep.eq([]);
    });

    it('lib/cjs/contracts requires nothing outside itself except @spinajs/di', () => {
      const { found, bad } = violations(CJS_DIR, /\.js$/);
      expect(found, 'scanner found no require in lib/cjs/contracts').to.include('./principal.js');
      expect(bad).to.deep.eq([]);
    });

    it('CJS loads only lib/cjs/contracts files and what @spinajs/di itself loads', () => {
      const diFiles = new Set(cjs.diFiles);
      expect(cjsAlone.loaded).to.include(join(CJS_DIR, 'index.js'));
      const outside = cjsAlone.loaded!.filter((f) => !isInside(CJS_DIR, f) && !diFiles.has(f));
      expect(outside).to.deep.eq([]);
    });

    it('CJS adds only lib/cjs/contracts files once @spinajs/di is loaded', () => {
      expect(cjs.contractFiles).to.not.be.empty;
      expect(cjs.contractFiles!.filter((f) => !isInside(CJS_DIR, f))).to.deep.eq([]);
    });
  });

  describe('DI', () => {
    it('ESM load registers nothing in the root container', () => {
      expect(esm.after).to.deep.eq(esm.before);
    });

    it('CJS load registers nothing in the root container', () => {
      expect(cjs.after).to.deep.eq(cjs.before);
    });
  });
});
