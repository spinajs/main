import 'mocha';
import { expect } from 'chai';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourcesIn(dir: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- scans the package's own directories
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourcesIn(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
}

describe('upload sources', () => {
  it('are valid UTF-8', () => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const invalid = [...sourcesIn(join(ROOT, 'src')), ...sourcesIn(join(ROOT, 'test'))].filter((file) => {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths come from the scan above
        decoder.decode(readFileSync(file));
        return false;
      } catch {
        return true;
      }
    });
    expect(invalid).to.deep.equal([]);
  });
});
