import 'mocha';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

// G1b: the guard is whatever AdminGuard DI provides; this package never loads authz-rbac.
describe('package boundaries', () => {
  it('no source file imports @spinajs/authz-rbac', () => {
    const offenders = sources(join(root, 'src')).filter((f) => /['"]@spinajs\/authz-rbac['"/]/.test(readFileSync(f, 'utf8')));
    expect(offenders).to.deep.equal([]);
  });

  it('package.json does not list @spinajs/authz-rbac', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) expect(Object.keys(pkg[key] ?? {}), key).to.not.include('@spinajs/authz-rbac');
  });
});
