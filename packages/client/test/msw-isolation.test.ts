import 'mocha';
import { expect } from 'chai';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
const packageJson = fileURLToPath(new URL('../package.json', import.meta.url));

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}${entry.name}`;
    return entry.isDirectory() ? sources(`${path}/`) : path.endsWith('.ts') ? [path] : [];
  });

describe('msw stays out of the runtime', () => {
  it('is imported by no file under src/ (it appears only inside the emitted text)', () => {
    const files = sources(srcDir);
    expect(files.length).to.be.greaterThan(0);
    const importing = files.filter((file) => /^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]msw(?:\/|['"])|\bimport\(\s*['"]msw|\brequire\(\s*['"]msw/m.test(readFileSync(file, 'utf8')));
    expect(importing).to.deep.equal([]);
  });

  it('is an optional peer dependency, not a dependency', () => {
    const pkg = JSON.parse(readFileSync(packageJson, 'utf8')) as { dependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> };
    expect(pkg.dependencies ?? {}).to.not.have.property('msw');
    expect(pkg.peerDependenciesMeta?.msw?.optional).to.equal(true);
  });
});
