import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { AuthnEventSink } from '@spinajs/authn/contracts';

import * as root from '../src/index.js';
import { SseSessionEndSink } from '../src/authn/index.js';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(PKG_ROOT, 'src');
const AUTHN_DIR = join(SRC, 'authn');

function listTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return listTs(p);
    return /\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [p] : [];
  });
}

const authnSpecifiers = (file: string): string[] =>
  ts
    .preProcessFile(readFileSync(file, 'utf8'), true, true)
    .importedFiles.map((f) => f.fileName)
    .filter((s) => s === '@spinajs/authn' || s.startsWith('@spinajs/authn/'));

describe('@spinajs/authn is an optional peer of authz-http', () => {
  it('only src/authn imports @spinajs/authn', () => {
    const files = listTs(SRC);
    expect(files.length).to.be.greaterThan(10);
    expect(files.filter((f) => relative(AUTHN_DIR, f).startsWith('..')).flatMap((f) => authnSpecifiers(f).map((s) => `${relative(PKG_ROOT, f)}: ${s}`))).to.deep.eq([]);
    expect(listTs(AUTHN_DIR).flatMap(authnSpecifiers)).to.include('@spinajs/authn/contracts');
  });

  it('declares @spinajs/authn as an optional peer and exports the ./authn subpath', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      exports: Record<string, unknown>;
    };
    expect(pkg.dependencies ?? {}).to.not.have.property('@spinajs/authn');
    expect(pkg.peerDependencies ?? {}).to.have.property('@spinajs/authn');
    expect(pkg.peerDependenciesMeta?.['@spinajs/authn']?.optional).to.eq(true);
    expect(pkg.exports['./authn']).to.deep.eq({ types: './lib/authn/index.d.ts', import: './lib/authn/index.js' });
  });

  it('serves the session-end sink from @spinajs/authz-http/authn, not from the root entry', () => {
    expect(root).to.not.have.property('SseSessionEndSink');
    expect(SseSessionEndSink.prototype).to.be.instanceOf(AuthnEventSink);
  });

  it('the root entry registers no authn sink; its bootstrapper loads the subpath when @spinajs/authn is installed', function () {
    this.timeout(60000);
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const body = `const { DI } = await import('@spinajs/di');
      const http = await import('@spinajs/authz-http');
      const registered = () => DI.RootContainer.hasRegisteredType('AuthnEventSink', 'SseSessionEndSink');
      const before = registered();
      await new http.AuthzHttpAuthnBootstrapper().bootstrap();
      console.log(JSON.stringify({ before, after: registered() }));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', body], { cwd: PKG_ROOT, encoding: 'utf8', env });
    expect(r.status, r.stderr).to.eq(0);
    const lines = r.stdout.trim().split(/\r?\n/);
    expect(JSON.parse(lines[lines.length - 1])).to.deep.eq({ before: false, after: true });
  });
});
